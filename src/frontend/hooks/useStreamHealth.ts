/**
 * useStreamHealth
 *
 * Tracks the SSE stream's health state and exposes the appropriate polling
 * interval for hooks that still need a fallback.
 *
 * When the stream is healthy (connected or reconnecting):
 *   → return `pollIntervalMs = SLOW_POLL_INTERVAL_MS` (5 minutes)
 *     This keeps SWR caches eventually-consistent even without events.
 *
 * When the stream is unhealthy (failed / idle / closed):
 *   → return `pollIntervalMs = FAST_POLL_INTERVAL_MS` (30 seconds)
 *     This matches the previous polling behaviour so users don't notice.
 *
 * Architecture note:
 *   - The leader tab updates `healthy` via BroadcastChannel messages
 *     (`__health__` type).  Follower tabs receive the same signal and also
 *     update their local health state.
 *   - In environments where BroadcastChannel is unavailable (SSR, old
 *     browsers), the hook falls back to reading `stream.state` directly.
 *
 * Implemented as a plain-TypeScript function — wrap with React `useState` /
 * `useEffect` in the actual component layer.
 *
 * Related: issue #1314
 */

import { getEventStream, type StreamState } from '../lib/eventStream';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Polling interval while the SSE stream is healthy.
 * 5 minutes — acts as a consistency safety net rather than the primary
 * update mechanism.
 */
export const SLOW_POLL_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Polling interval when SSE is unavailable or has failed.
 * 30 seconds — matches the previous polling cadence so UX is unchanged.
 */
export const FAST_POLL_INTERVAL_MS = 30 * 1_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StreamHealth {
  /** Whether the stream is currently delivering events. */
  healthy: boolean;
  /**
   * Recommended SWR `refreshInterval` based on stream health.
   * Pass this directly to `useSWR(key, fetcher, { refreshInterval })`.
   */
  pollIntervalMs: number;
  /** Raw stream lifecycle state. */
  streamState: StreamState;
}

// ─── Hook implementation ──────────────────────────────────────────────────────

/**
 * Returns the current stream health derived from the EventStreamManager state.
 *
 * Call inside a React effect that subscribes to state changes (e.g. by
 * polling `getEventStream().state` on an interval, or by wiring a state-change
 * callback):
 *
 * ```tsx
 * const [health, setHealth] = useState(() => getStreamHealth());
 * useEffect(() => {
 *   const id = setInterval(() => setHealth(getStreamHealth()), 5_000);
 *   return () => clearInterval(id);
 * }, []);
 * ```
 */
export function getStreamHealth(): StreamHealth {
  const stream = getEventStream();
  const state = stream.state;
  const healthy = state === 'connected' || state === 'reconnecting';
  return {
    healthy,
    pollIntervalMs: healthy ? SLOW_POLL_INTERVAL_MS : FAST_POLL_INTERVAL_MS,
    streamState: state,
  };
}

/**
 * Derive `StreamHealth` from an explicit `StreamState` value.
 * Useful in tests and in components that track state reactively via useState.
 */
export function streamHealthFromState(state: StreamState): StreamHealth {
  const healthy = state === 'connected' || state === 'reconnecting';
  return {
    healthy,
    pollIntervalMs: healthy ? SLOW_POLL_INTERVAL_MS : FAST_POLL_INTERVAL_MS,
    streamState: state,
  };
}
