/**
 * eventStream.ts
 *
 * Shared SSE subscription manager for the ScoutOff frontend.
 *
 * Architecture — one EventSource per browser, zero per follower tab:
 *
 *   ┌──────────────┐    BroadcastChannel    ┌──────────────┐
 *   │  Leader tab  │ ──────────────────────▶│ Follower tab │
 *   │  EventSource │                        │  (no ES)     │
 *   └──────────────┘                        └──────────────┘
 *
 * Leader election uses the Web Locks API (`navigator.locks.request`):
 *   - Every tab calls `navigator.locks.request('sse_leader', { ifAvailable: false }, cb)`.
 *   - The browser grants the lock to exactly one tab at a time.
 *   - When the leader tab closes the lock is released and another tab wins.
 *   - Followers listen on a BroadcastChannel for events forwarded by the leader.
 *
 * The `EventStreamManager` is a singleton per tab. Call `connect(token)` once
 * with the user's JWT; call `disconnect()` on logout or unmount.
 *
 * Reconnect strategy:
 *   - The leader reconnects on error using truncated exponential back-off
 *     (1 s → 2 s → 4 s … cap at 30 s).
 *   - On reconnect the `Last-Event-ID` header is sent so the server can
 *     replay missed events (if the backend supports it).
 *   - After MAX_RECONNECT_ATTEMPTS consecutive failures the stream enters
 *     FAILED state and stops reconnecting; callers should fall back to polling.
 *
 * Health broadcast:
 *   - The leader posts `{ type: '__health__', payload: { healthy: boolean } }`
 *     over BroadcastChannel whenever the stream connects or exhausts retries.
 *   - useStreamHealth subscribes to this to drive the polling fallback.
 *
 * Related: issue #1314, docs/events.md
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Web Locks lock name shared across all tabs for leader election. */
const LOCK_NAME = 'scout_off_sse_leader';

/** BroadcastChannel name shared across all tabs. */
const CHANNEL_NAME = 'scout_off_sse';

/** Base reconnect delay in milliseconds. */
const BASE_RECONNECT_DELAY_MS = 1_000;

/** Maximum reconnect delay after back-off. */
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Number of consecutive failures before giving up and going to FAILED state. */
const MAX_RECONNECT_ATTEMPTS = 10;

/** Heartbeat timeout: if no frame arrives within this many ms, reconnect. */
const HEARTBEAT_TIMEOUT_MS = 60_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/** All valid contract event type names (mirrors ContractEventType in src/types). */
export type ContractEventType =
  | 'player_registered'
  | 'milestone_submitted'
  | 'milestone_approved'
  | 'scout_subscribed'
  | 'contact_unlocked'
  | 'trial_offer_logged'
  | 'trial_offer_accepted'
  | 'trial_offer_rejected'
  | 'fees_withdrawn'
  | 'player_deactivated'
  | 'player_reactivated';

/** An event payload delivered by the stream. */
export interface StreamEvent {
  type: ContractEventType;
  payload: Record<string, unknown>;
}

/** Internal BroadcastChannel message shape. */
export type ChannelMessage =
  | { type: 'event'; event: StreamEvent }
  | { type: '__health__'; payload: { healthy: boolean } };

/** Stream lifecycle states. */
export type StreamState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

/** Handler registered for a specific event type. */
export type EventHandler = (event: StreamEvent) => void;

/** Unsubscribe function returned by `onEvent`. */
export type Unsubscribe = () => void;

// ─── EventStreamManager ───────────────────────────────────────────────────────

/**
 * Manages a single SSE connection shared across browser tabs via Web Locks
 * leader election and BroadcastChannel forwarding.
 *
 * Instantiate once per application (typically via `getEventStream()`).
 */
export class EventStreamManager {
  // ── Public observable state ──────────────────────────────────────────────────
  state: StreamState = 'idle';

  // ── Private fields ───────────────────────────────────────────────────────────
  private _token: string | null = null;
  private _url: string;
  private _es: EventSource | null = null;
  private _channel: BroadcastChannel | null = null;
  private _handlers = new Map<ContractEventType | '*', Set<EventHandler>>();
  private _reconnectAttempts = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastEventId: string | null = null;
  private _isLeader = false;
  private _lockAbortController: AbortController | null = null;

  /**
   * @param url  Full URL of the SSE stream endpoint, e.g.
   *             `https://api.scoutoff.io/api/events/stream` or
   *             `/api/indexer/stream` (via Next.js proxy).
   */
  constructor(url: string) {
    this._url = url;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Connect the stream for the authenticated user.
   *
   * This is safe to call multiple times; subsequent calls with the same token
   * are no-ops.  Pass a new token (e.g. after token refresh) to force a
   * reconnect.
   *
   * @param token  JWT access token (Bearer value, without "Bearer " prefix).
   */
  connect(token: string): void {
    if (this.state === 'closed') return; // permanent close after logout

    if (this._token === token && this._es) return; // already connected

    this._token = token;
    this.state = 'connecting';

    this._ensureChannel();
    this._electLeader();
  }

  /**
   * Permanently disconnect and clean up.  Call on logout or component unmount.
   * After calling this, `connect()` will be silently ignored.
   */
  disconnect(): void {
    this.state = 'closed';
    this._teardown();
  }

  /**
   * Register a handler for a specific event type or `'*'` for all events.
   *
   * @returns  An `unsubscribe` function — call it to remove the handler.
   */
  onEvent(type: ContractEventType | '*', handler: EventHandler): Unsubscribe {
    if (!this._handlers.has(type)) {
      this._handlers.set(type, new Set());
    }
    this._handlers.get(type)!.add(handler);
    return () => {
      this._handlers.get(type)?.delete(handler);
    };
  }

  /** Whether this tab currently holds the leader lock. */
  get isLeader(): boolean {
    return this._isLeader;
  }

  // ── Leader election ───────────────────────────────────────────────────────────

  private _electLeader(): void {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      // Web Locks not available (SSR, old browser) — just open a connection
      // directly without leader election.
      this._becomeLeader();
      return;
    }

    // Cancel any previous lock request before making a new one.
    if (this._lockAbortController) {
      this._lockAbortController.abort();
    }
    this._lockAbortController = new AbortController();

    navigator.locks.request(
      LOCK_NAME,
      { signal: this._lockAbortController.signal },
      async () => {
        // We hold the lock — become the leader.
        this._becomeLeader();

        // Return a Promise that stays pending for as long as we want to hold
        // the lock.  We resolve it when we disconnect.
        return new Promise<void>((resolve) => {
          // Store resolver so disconnect() can release the lock.
          (this as unknown as { _releaseLock?: () => void })._releaseLock = resolve;
        });
      },
    ).catch((err: Error) => {
      // AbortError is expected when we cancel a pending lock request.
      if (err.name !== 'AbortError') {
        console.warn('[eventStream] lock request error:', err);
        // Fall back to direct connection if locks fail.
        this._becomeLeader();
      }
    });
  }

  private _becomeLeader(): void {
    this._isLeader = true;
    this._reconnectAttempts = 0;
    this._openEventSource();
  }

  // ── EventSource lifecycle ─────────────────────────────────────────────────────

  private _buildUrl(): string {
    const url = new URL(this._url, typeof window !== 'undefined' ? window.location.href : 'http://localhost');
    if (this._token) url.searchParams.set('token', this._token);
    if (this._lastEventId) url.searchParams.set('lastEventId', this._lastEventId);
    return url.toString();
  }

  private _openEventSource(): void {
    if (!this._token || this.state === 'closed') return;

    this.state = this._reconnectAttempts > 0 ? 'reconnecting' : 'connecting';

    const es = new EventSource(this._buildUrl());
    this._es = es;

    es.addEventListener('connected', () => {
      this._reconnectAttempts = 0;
      this.state = 'connected';
      this._broadcastHealth(true);
      this._resetHeartbeat();
    });

    // Handle all named contract event types.
    const CONTRACT_EVENTS: ContractEventType[] = [
      'player_registered',
      'milestone_submitted',
      'milestone_approved',
      'scout_subscribed',
      'contact_unlocked',
      'trial_offer_logged',
      'trial_offer_accepted',
      'trial_offer_rejected',
      'fees_withdrawn',
      'player_deactivated',
      'player_reactivated',
    ];

    for (const eventType of CONTRACT_EVENTS) {
      es.addEventListener(eventType, (e: MessageEvent) => {
        this._handleRawEvent(eventType, e);
      });
    }

    es.addEventListener('session_ended', (e: MessageEvent) => {
      // The server closed our session (token revoked / wallet blocklisted).
      console.warn('[eventStream] session ended by server:', e.data);
      this.disconnect();
    });

    es.onerror = () => {
      this._scheduleReconnect();
    };
  }

  private _handleRawEvent(type: ContractEventType, e: MessageEvent): void {
    this._resetHeartbeat();

    let event: StreamEvent;
    try {
      const parsed = JSON.parse(e.data) as { type: ContractEventType; payload: Record<string, unknown> };
      event = { type: parsed.type ?? type, payload: parsed.payload ?? {} };
    } catch {
      event = { type, payload: {} };
    }

    // Track last seen event ID for resume (Last-Event-ID).
    if (e.lastEventId) {
      this._lastEventId = e.lastEventId;
    }

    // Forward to followers via BroadcastChannel.
    this._broadcastEvent(event);

    // Dispatch to local handlers.
    this._dispatch(event);
  }

  private _scheduleReconnect(): void {
    if (this.state === 'closed') return;

    this._closeEventSource();

    this._reconnectAttempts += 1;

    if (this._reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      this.state = 'failed';
      this._broadcastHealth(false);
      return;
    }

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** (this._reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS,
    );

    this.state = 'reconnecting';
    this._reconnectTimer = setTimeout(() => {
      this._openEventSource();
    }, delay);
  }

  private _closeEventSource(): void {
    if (this._es) {
      this._es.close();
      this._es = null;
    }
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._heartbeatTimer !== null) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────────

  private _resetHeartbeat(): void {
    if (this._heartbeatTimer !== null) clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = setTimeout(() => {
      // No frame received — treat as a stale connection and reconnect.
      this._scheduleReconnect();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  // ── BroadcastChannel ─────────────────────────────────────────────────────────

  private _ensureChannel(): void {
    if (this._channel) return;
    if (typeof BroadcastChannel === 'undefined') return; // SSR guard

    this._channel = new BroadcastChannel(CHANNEL_NAME);
    this._channel.onmessage = (e: MessageEvent<ChannelMessage>) => {
      const msg = e.data;
      if (!msg) return;

      if (msg.type === 'event') {
        this._dispatch(msg.event);
      } else if (msg.type === '__health__') {
        // Update local state from leader's health broadcast.
        if (!this._isLeader) {
          this.state = msg.payload.healthy ? 'connected' : 'failed';
        }
      }
    };
  }

  private _broadcastEvent(event: StreamEvent): void {
    if (!this._channel) return;
    const msg: ChannelMessage = { type: 'event', event };
    try {
      this._channel.postMessage(msg);
    } catch {
      // Channel may be closed during teardown; ignore.
    }
  }

  private _broadcastHealth(healthy: boolean): void {
    if (!this._channel) return;
    const msg: ChannelMessage = { type: '__health__', payload: { healthy } };
    try {
      this._channel.postMessage(msg);
    } catch {
      // ignore
    }
  }

  // ── Event dispatch ────────────────────────────────────────────────────────────

  private _dispatch(event: StreamEvent): void {
    const typeHandlers = this._handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          handler(event);
        } catch (err) {
          console.error('[eventStream] handler error:', err);
        }
      }
    }
    const wildcardHandlers = this._handlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(event);
        } catch (err) {
          console.error('[eventStream] wildcard handler error:', err);
        }
      }
    }
  }

  // ── Teardown ─────────────────────────────────────────────────────────────────

  private _teardown(): void {
    this._isLeader = false;
    this._closeEventSource();

    // Release the Web Locks lock if we hold it.
    const release = (this as unknown as { _releaseLock?: () => void })._releaseLock;
    if (release) {
      release();
      delete (this as unknown as { _releaseLock?: () => void })._releaseLock;
    }

    // Abort any pending lock request.
    if (this._lockAbortController) {
      this._lockAbortController.abort();
      this._lockAbortController = null;
    }

    if (this._channel) {
      this._channel.close();
      this._channel = null;
    }

    this._handlers.clear();
    this._token = null;
  }
}

// ─── Singleton accessor ───────────────────────────────────────────────────────

let _instance: EventStreamManager | null = null;

/**
 * Returns the process-wide (per-tab) singleton `EventStreamManager`.
 *
 * The URL defaults to `/api/indexer/stream` (the Next.js proxy route) but
 * can be overridden via `NEXT_PUBLIC_INDEXER_STREAM_URL`.
 */
export function getEventStream(): EventStreamManager {
  if (!_instance) {
    const url =
      (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_INDEXER_STREAM_URL) ||
      '/api/indexer/stream';
    _instance = new EventStreamManager(url);
  }
  return _instance;
}

/**
 * Replace the singleton — **for testing only**.
 */
export function _setEventStreamForTests(instance: EventStreamManager | null): void {
  _instance = instance;
}
