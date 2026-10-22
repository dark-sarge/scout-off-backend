/**
 * Tests for src/frontend/hooks/useContractEvents.ts
 *
 * Coverage:
 *   - connect() is called with the token when a token is provided
 *   - connect() is NOT called when token is null
 *   - onEvent() proxies to the stream manager
 *   - invalidate() calls the provided mutate function with the key
 *   - streamState reflects the current stream state
 *   - onEvent() unsubscribe works correctly
 *   - Multiple handlers can be registered for the same event type
 */

import {
  useContractEvents,
  type ContractEventsDeps,
} from '../../../src/frontend/hooks/useContractEvents';
import {
  EventStreamManager,
  _setEventStreamForTests,
} from '../../../src/frontend/lib/eventStream';

// ─── Browser API stubs (required before constructing EventStreamManager) ──────

// EventSource stub — EventStreamManager only calls `new EventSource()` inside
// `_openEventSource()`, which is guarded behind `_becomeLeader()` → lock
// callback. Since we spy on `connect()` below, _openEventSource never runs in
// these tests, but the global must exist to satisfy the TypeScript / runtime path.
class StubEventSource {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_url: string) { /* no-op */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  addEventListener(_type: string, _fn: unknown): void { /* no-op */ }
  close(): void { /* no-op */ }
}

class StubBroadcastChannel {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_name: string) { /* no-op */ }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: ((e: MessageEvent) => void) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  postMessage(_data: unknown): void { /* no-op */ }
  close(): void { /* no-op */ }
}

// Set up globals before anything imports eventStream.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).EventSource = StubEventSource;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).BroadcastChannel = StubBroadcastChannel;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
Object.defineProperty(global, 'navigator', {
  writable: true,
  value: { locks: { request: jest.fn((_n: unknown, _o: unknown, cb: () => Promise<void>) => cb()) } },
});

// ─── Setup ────────────────────────────────────────────────────────────────────

let mockStream: EventStreamManager;
let connectSpy: jest.SpyInstance;
let onEventSpy: jest.SpyInstance;
let mutateMock: jest.Mock;

beforeEach(() => {
  // Create a real manager but spy on its methods so no actual EventSource opens.
  mockStream = new EventStreamManager('/api/indexer/stream');
  connectSpy = jest.spyOn(mockStream, 'connect').mockImplementation(() => { /* no-op */ });
  onEventSpy = jest.spyOn(mockStream, 'onEvent');
  mutateMock = jest.fn();

  // Inject mock stream as the singleton.
  _setEventStreamForTests(mockStream);
});

afterEach(() => {
  _setEventStreamForTests(null);
  jest.restoreAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<ContractEventsDeps> = {}): ContractEventsDeps {
  return {
    token: 'test-token',
    mutate: mutateMock,
    ...overrides,
  };
}

// ─── connect() wiring ─────────────────────────────────────────────────────────

describe('token wiring', () => {
  it('calls stream.connect() with the provided token', () => {
    useContractEvents(makeDeps({ token: 'my-jwt' }));
    expect(connectSpy).toHaveBeenCalledWith('my-jwt');
  });

  it('does NOT call stream.connect() when token is null', () => {
    useContractEvents(makeDeps({ token: null }));
    expect(connectSpy).not.toHaveBeenCalled();
  });
});

// ─── onEvent() ────────────────────────────────────────────────────────────────

describe('onEvent()', () => {
  it('returns a function', () => {
    const { onEvent } = useContractEvents(makeDeps());
    const result = onEvent('milestone_approved', jest.fn());
    expect(typeof result).toBe('function');
  });

  it('proxies the call to stream.onEvent()', () => {
    const handler = jest.fn();
    const { onEvent } = useContractEvents(makeDeps());
    onEvent('milestone_approved', handler);
    expect(onEventSpy).toHaveBeenCalledWith('milestone_approved', handler);
  });

  it('calling the returned unsubscribe removes the handler', () => {
    // Track handlers registered.
    const registeredHandlers: Map<string, Set<(...args: unknown[]) => unknown>> = new Map();
    onEventSpy.mockImplementation((type: string, fn: (...args: unknown[]) => unknown) => {
      if (!registeredHandlers.has(type)) registeredHandlers.set(type, new Set());
      registeredHandlers.get(type)!.add(fn);
      return () => registeredHandlers.get(type)?.delete(fn);
    });

    const handler = jest.fn();
    const { onEvent } = useContractEvents(makeDeps());
    const unsub = onEvent('contact_unlocked', handler);

    expect(registeredHandlers.get('contact_unlocked')?.has(handler)).toBe(true);
    unsub();
    expect(registeredHandlers.get('contact_unlocked')?.has(handler)).toBe(false);
  });

  it('supports wildcard * type', () => {
    const handler = jest.fn();
    const { onEvent } = useContractEvents(makeDeps());
    onEvent('*', handler);
    expect(onEventSpy).toHaveBeenCalledWith('*', handler);
  });
});

// ─── invalidate() ─────────────────────────────────────────────────────────────

describe('invalidate()', () => {
  it('calls mutate with the given key', () => {
    const { invalidate } = useContractEvents(makeDeps());
    invalidate('/api/players/p1/milestones');
    expect(mutateMock).toHaveBeenCalledWith('/api/players/p1/milestones');
  });

  it('calls mutate with different keys independently', () => {
    const { invalidate } = useContractEvents(makeDeps());
    invalidate('/api/players/p1');
    invalidate('/api/scouts/GXXX/subscription');
    expect(mutateMock).toHaveBeenCalledTimes(2);
    expect(mutateMock).toHaveBeenNthCalledWith(1, '/api/players/p1');
    expect(mutateMock).toHaveBeenNthCalledWith(2, '/api/scouts/GXXX/subscription');
  });
});

// ─── streamState ─────────────────────────────────────────────────────────────

describe('streamState', () => {
  it('reflects the current stream state (idle by default)', () => {
    const { streamState } = useContractEvents(makeDeps());
    expect(streamState).toBe('idle');
  });

  it('reflects state after connect sets it', () => {
    // Mock connect to change state.
    connectSpy.mockImplementation(() => {
      mockStream.state = 'connecting';
    });
    useContractEvents(makeDeps());
    const { streamState } = useContractEvents(makeDeps());
    expect(streamState).toBe('connecting');
  });
});

// ─── Multiple handlers ────────────────────────────────────────────────────────

describe('multiple handlers', () => {
  it('allows multiple handlers for the same event type', () => {
    const handlerA = jest.fn();
    const handlerB = jest.fn();
    const { onEvent } = useContractEvents(makeDeps());

    onEvent('scout_subscribed', handlerA);
    onEvent('scout_subscribed', handlerB);

    expect(onEventSpy).toHaveBeenCalledTimes(2);
  });
});
