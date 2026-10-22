/**
 * Tests for src/frontend/lib/eventStream.ts
 *
 * Coverage:
 *   - EventStreamManager initial state
 *   - connect() opens an EventSource when a token is given
 *   - Leader election: Web Locks path and no-locks fallback
 *   - onEvent() registers a handler and returns a working unsubscribe fn
 *   - Event dispatch: handlers are called when EventSource fires
 *   - Wildcard '*' handlers receive all event types
 *   - BroadcastChannel: leader forwards events to channel
 *   - BroadcastChannel: follower receives events via channel and dispatches locally
 *   - Health broadcast: 'connected' event sets state = 'connected' and broadcasts health
 *   - Reconnect: onerror schedules a retry with back-off
 *   - MAX_RECONNECT_ATTEMPTS: after N failures state = 'failed', health broadcast = false
 *   - Heartbeat timeout: triggers reconnect after HEARTBEAT_TIMEOUT_MS
 *   - disconnect() closes the EventSource and channel
 *   - Singleton: getEventStream() returns the same instance
 *   - _setEventStreamForTests() replaces the singleton
 *   - connect() is a no-op after disconnect()
 *   - Handler errors are caught and do not crash the stream
 *   - Last-Event-ID is tracked and appended to the reconnect URL
 */

import {
  EventStreamManager,
  getEventStream,
  _setEventStreamForTests,
  type StreamEvent,
  type ContractEventType,
} from '../../../src/frontend/lib/eventStream';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listeners: Map<string, Array<(e: any) => void>> = new Map();
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  lastEventId = '';

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, fn: (e: any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
  }

  close(): void {
    this.closed = true;
  }

  /** Helper: trigger a named event with data. */
  emit(type: string, data: string, lastEventId = ''): void {
    const handlers = this.listeners.get(type) ?? [];
    for (const h of handlers) {
      h({ data, lastEventId, type } as MessageEvent);
    }
  }

  /** Helper: trigger onerror. */
  triggerError(): void {
    if (this.onerror) this.onerror(new Event('error'));
  }
}

// Mock BroadcastChannel
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  onmessage: ((e: MessageEvent) => void) | null = null;
  messages: unknown[] = [];
  closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    this.messages.push(data);
    // Forward to other open channels with the same name (simulate cross-tab).
    for (const ch of MockBroadcastChannel.instances) {
      if (ch !== this && ch.name === this.name && !ch.closed && ch.onmessage) {
        ch.onmessage({ data } as MessageEvent);
      }
    }
  }

  close(): void {
    this.closed = true;
  }
}

// Mock navigator.locks
const mockLockCallbacks: Array<() => Promise<void>> = [];
let lockGranted = false;

const mockLocks = {
  request: jest.fn(
    (_name: string, _options: unknown, cb: () => Promise<void>) => {
      lockGranted = true;
      const p = cb();
      mockLockCallbacks.push(() => p);
      return p.catch((e: Error) => {
        if (e.name !== 'AbortError') throw e;
      });
    },
  ),
};

// ─── Setup ────────────────────────────────────────────────────────────────────

const ORIGINAL_EVENTSOURCE = global.EventSource;
const ORIGINAL_BROADCAST = global.BroadcastChannel;
const ORIGINAL_NAVIGATOR = global.navigator;

beforeEach(() => {
  jest.useFakeTimers();
  MockEventSource.instances = [];
  MockBroadcastChannel.instances = [];
  mockLockCallbacks.length = 0;
  lockGranted = false;
  mockLocks.request.mockClear();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).EventSource = MockEventSource;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).BroadcastChannel = MockBroadcastChannel;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Object.defineProperty(global, 'navigator', {
    writable: true,
    value: { locks: mockLocks },
  });

  // Always start with a fresh instance.
  _setEventStreamForTests(null);
});

afterEach(() => {
  jest.useRealTimers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).EventSource = ORIGINAL_EVENTSOURCE;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).BroadcastChannel = ORIGINAL_BROADCAST;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Object.defineProperty(global, 'navigator', { writable: true, value: ORIGINAL_NAVIGATOR });
  _setEventStreamForTests(null);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeManager(): EventStreamManager {
  return new EventStreamManager('/api/indexer/stream');
}

function connectAndGetEs(manager: EventStreamManager, token = 'tok'): MockEventSource {
  manager.connect(token);
  // By default locks are available — leader becomes active synchronously in our mock.
  expect(MockEventSource.instances.length).toBe(1);
  return MockEventSource.instances[0];
}

// ─── Initial state ────────────────────────────────────────────────────────────

describe('initial state', () => {
  it('starts in idle state', () => {
    const m = makeManager();
    expect(m.state).toBe('idle');
  });

  it('isLeader is false before connect', () => {
    const m = makeManager();
    expect(m.isLeader).toBe(false);
  });
});

// ─── connect() ────────────────────────────────────────────────────────────────

describe('connect()', () => {
  it('opens an EventSource after gaining the lock', () => {
    const m = makeManager();
    m.connect('tok');
    expect(MockEventSource.instances.length).toBe(1);
  });

  it('sets state to connecting', () => {
    const m = makeManager();
    m.connect('tok');
    expect(m.state).toBe('connecting');
  });

  it('opens a BroadcastChannel', () => {
    const m = makeManager();
    m.connect('tok');
    expect(MockBroadcastChannel.instances.length).toBe(1);
  });

  it('includes token in EventSource URL', () => {
    const m = makeManager();
    m.connect('my-jwt');
    const es = MockEventSource.instances[0];
    expect(es.url).toContain('token=my-jwt');
  });

  it('is a no-op if called twice with the same token', () => {
    const m = makeManager();
    m.connect('tok');
    m.connect('tok');
    expect(MockEventSource.instances.length).toBe(1);
  });

  it('reconnects when called with a new token', () => {
    const m = makeManager();
    m.connect('tok1');
    m.connect('tok2');
    // New EventSource should be opened.
    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
    const latest = MockEventSource.instances[MockEventSource.instances.length - 1];
    expect(latest.url).toContain('token=tok2');
  });

  it('is a no-op after disconnect()', () => {
    const m = makeManager();
    m.connect('tok');
    m.disconnect();
    m.connect('tok2');
    // Should not open a new EventSource after permanent close.
    expect(m.state).toBe('closed');
  });
});

// ─── Leader election ──────────────────────────────────────────────────────────

describe('leader election — Web Locks available', () => {
  it('calls navigator.locks.request with the lock name', () => {
    const m = makeManager();
    m.connect('tok');
    expect(mockLocks.request).toHaveBeenCalledWith(
      'scout_off_sse_leader',
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('sets isLeader = true after receiving the lock', () => {
    const m = makeManager();
    m.connect('tok');
    expect(lockGranted).toBe(true);
    expect(m.isLeader).toBe(true);
  });
});

describe('leader election — Web Locks unavailable', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty(global, 'navigator', { writable: true, value: {} });
  });

  it('falls back to opening EventSource directly without locks', () => {
    const m = makeManager();
    m.connect('tok');
    expect(MockEventSource.instances.length).toBe(1);
    expect(m.isLeader).toBe(true);
  });
});

// ─── onEvent() ────────────────────────────────────────────────────────────────

describe('onEvent()', () => {
  it('calls the handler when a matching event arrives', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    const handler = jest.fn();
    m.onEvent('milestone_approved', handler);

    const eventData = JSON.stringify({ type: 'milestone_approved', payload: { player_id: 'p1' } });
    es.emit('milestone_approved', eventData);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'milestone_approved' }),
    );
  });

  it('returns an unsubscribe function that removes the handler', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    const handler = jest.fn();
    const unsub = m.onEvent('milestone_approved', handler);

    unsub();
    es.emit('milestone_approved', JSON.stringify({ type: 'milestone_approved', payload: {} }));

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not call handlers registered for other event types', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    const handler = jest.fn();
    m.onEvent('scout_subscribed', handler);

    es.emit('milestone_approved', JSON.stringify({ type: 'milestone_approved', payload: {} }));

    expect(handler).not.toHaveBeenCalled();
  });
});

// ─── Wildcard handlers ────────────────────────────────────────────────────────

describe('wildcard * handler', () => {
  it('receives all event types', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    const handler = jest.fn();
    m.onEvent('*', handler);

    const types: ContractEventType[] = ['milestone_approved', 'scout_subscribed', 'contact_unlocked'];
    for (const t of types) {
      es.emit(t, JSON.stringify({ type: t, payload: {} }));
    }

    expect(handler).toHaveBeenCalledTimes(types.length);
  });
});

// ─── BroadcastChannel — leader forwards events ─────────────────────────────────

describe('BroadcastChannel — leader forwards events', () => {
  it('posts an "event" message for each received event', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    // Simulate connected event so state = connected.
    es.emit('connected', JSON.stringify({ wallet: 'G...' }));

    es.emit('milestone_approved', JSON.stringify({ type: 'milestone_approved', payload: { player_id: 'p1' } }));

    const channel = MockBroadcastChannel.instances[0];
    const eventMsgs = channel.messages.filter(
      (msg) => (msg as { type: string }).type === 'event',
    );
    expect(eventMsgs.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── BroadcastChannel — follower receives events ────────────────────────────────

describe('BroadcastChannel — follower receives events', () => {
  it('dispatches events received from the channel to local handlers', () => {
    // Follower has no lock — simulate by creating a fresh manager that
    // receives events only via channel.
    const follower = makeManager();
    follower.connect('tok');

    // Manually inject a channel message (bypassing lock/ES).
    const channel = MockBroadcastChannel.instances[0];
    const handler = jest.fn();
    follower.onEvent('scout_subscribed', handler);

    const event: StreamEvent = { type: 'scout_subscribed', payload: { scout: 'G...' } };
    // Simulate receiving from channel.
    channel.onmessage?.({ data: { type: 'event', event } } as MessageEvent);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it('updates state from __health__ message', () => {
    const follower = makeManager();
    follower.connect('tok');
    // Make follower not the leader so health updates apply.
    (follower as unknown as { _isLeader: boolean })._isLeader = false;

    const channel = MockBroadcastChannel.instances[0];
    channel.onmessage?.({
      data: { type: '__health__', payload: { healthy: true } },
    } as MessageEvent);

    expect(follower.state).toBe('connected');
  });
});

// ─── Health broadcast ─────────────────────────────────────────────────────────

describe('health broadcast', () => {
  it('posts __health__ true when connected event arrives', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    es.emit('connected', JSON.stringify({ wallet: 'G...' }));

    const channel = MockBroadcastChannel.instances[0];
    const healthMsgs = channel.messages.filter(
      (msg) => (msg as { type: string }).type === '__health__',
    ) as Array<{ type: '__health__'; payload: { healthy: boolean } }>;

    expect(healthMsgs.length).toBeGreaterThanOrEqual(1);
    expect(healthMsgs[healthMsgs.length - 1].payload.healthy).toBe(true);
  });

  it('sets state to connected when connected event arrives', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    es.emit('connected', JSON.stringify({ wallet: 'G...' }));
    expect(m.state).toBe('connected');
  });
});

// ─── Reconnect back-off ───────────────────────────────────────────────────────

describe('reconnect back-off', () => {
  it('schedules a retry after onerror', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    es.onerror?.(new Event('error'));
    expect(m.state).toBe('reconnecting');
  });

  it('opens a new EventSource after the back-off delay', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    es.onerror?.(new Event('error'));

    // Advance past the first retry delay (1s).
    jest.advanceTimersByTime(1_500);

    expect(MockEventSource.instances.length).toBe(2);
  });

  it('closes the old EventSource before reopening', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    es.onerror?.(new Event('error'));
    jest.advanceTimersByTime(1_500);
    expect(es.closed).toBe(true);
  });

  it('enters FAILED state after MAX_RECONNECT_ATTEMPTS consecutive failures', () => {
    const m = makeManager();
    connectAndGetEs(m);

    // Simulate 11 consecutive failures (> MAX_RECONNECT_ATTEMPTS = 10).
    for (let i = 0; i < 11; i++) {
      const latest = MockEventSource.instances[MockEventSource.instances.length - 1];
      latest.onerror?.(new Event('error'));
      jest.runAllTimers();
    }

    expect(m.state).toBe('failed');
  });

  it('broadcasts health=false when FAILED', () => {
    const m = makeManager();
    connectAndGetEs(m);

    for (let i = 0; i < 11; i++) {
      const latest = MockEventSource.instances[MockEventSource.instances.length - 1];
      latest.onerror?.(new Event('error'));
      jest.runAllTimers();
    }

    const channel = MockBroadcastChannel.instances[0];
    const healthMsgs = channel.messages.filter(
      (msg) => (msg as { type: string }).type === '__health__',
    ) as Array<{ type: '__health__'; payload: { healthy: boolean } }>;

    const lastHealth = healthMsgs[healthMsgs.length - 1];
    expect(lastHealth?.payload.healthy).toBe(false);
  });

  it('includes lastEventId in reconnect URL', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);

    // Simulate receiving an event with a lastEventId.
    es.emit(
      'milestone_approved',
      JSON.stringify({ type: 'milestone_approved', payload: {} }),
      'ledger:42',
    );

    // Trigger reconnect.
    es.onerror?.(new Event('error'));
    jest.advanceTimersByTime(1_500);

    const newEs = MockEventSource.instances[MockEventSource.instances.length - 1];
    expect(newEs.url).toContain('lastEventId=ledger%3A42');
  });
});

// ─── Heartbeat timeout ────────────────────────────────────────────────────────

describe('heartbeat timeout', () => {
  it('triggers reconnect if no frame arrives within HEARTBEAT_TIMEOUT_MS', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    // Simulate connected.
    es.emit('connected', JSON.stringify({ wallet: 'G...' }));

    // Advance past heartbeat timeout (60s).
    jest.advanceTimersByTime(61_000);

    expect(m.state).toBe('reconnecting');
  });

  it('resets heartbeat timer when an event arrives', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    es.emit('connected', JSON.stringify({ wallet: 'G...' }));

    // Advance to just before heartbeat timeout.
    jest.advanceTimersByTime(59_000);
    // Receive an event — should reset the timer.
    es.emit('milestone_approved', JSON.stringify({ type: 'milestone_approved', payload: {} }));

    // Advance another 59s (total 118s but last event was at 59s, so only 59s elapsed).
    jest.advanceTimersByTime(59_000);

    // Should still be connected (not yet timed out after reset).
    expect(m.state).toBe('connected');
  });
});

// ─── disconnect() ────────────────────────────────────────────────────────────

describe('disconnect()', () => {
  it('sets state to closed', () => {
    const m = makeManager();
    m.connect('tok');
    m.disconnect();
    expect(m.state).toBe('closed');
  });

  it('closes the EventSource', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    m.disconnect();
    expect(es.closed).toBe(true);
  });

  it('closes the BroadcastChannel', () => {
    const m = makeManager();
    m.connect('tok');
    const channel = MockBroadcastChannel.instances[0];
    m.disconnect();
    expect(channel.closed).toBe(true);
  });

  it('stops dispatching events after disconnect', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    const handler = jest.fn();
    m.onEvent('*', handler);
    m.disconnect();
    es.emit('milestone_approved', JSON.stringify({ type: 'milestone_approved', payload: {} }));
    // Handlers were cleared.
    expect(handler).not.toHaveBeenCalled();
  });
});

// ─── Error resilience ─────────────────────────────────────────────────────────

describe('handler error resilience', () => {
  it('catches errors thrown by handlers and continues dispatching to others', () => {
    const m = makeManager();
    const es = connectAndGetEs(m);
    const badHandler = jest.fn().mockImplementation(() => { throw new Error('oops'); });
    const goodHandler = jest.fn();

    m.onEvent('milestone_approved', badHandler);
    m.onEvent('milestone_approved', goodHandler);

    es.emit('milestone_approved', JSON.stringify({ type: 'milestone_approved', payload: {} }));

    expect(badHandler).toHaveBeenCalledTimes(1);
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });
});

// ─── Singleton ────────────────────────────────────────────────────────────────

describe('singleton', () => {
  it('getEventStream() returns the same instance on repeated calls', () => {
    const a = getEventStream();
    const b = getEventStream();
    expect(a).toBe(b);
  });

  it('_setEventStreamForTests(null) resets the singleton', () => {
    const a = getEventStream();
    _setEventStreamForTests(null);
    const b = getEventStream();
    expect(a).not.toBe(b);
  });
});
