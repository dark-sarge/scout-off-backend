/**
 * useContractEvents
 *
 * Central hook that wires the EventStreamManager into the React component
 * lifecycle.  It:
 *
 *   1. Connects (or reconnects) the singleton stream when a valid JWT is
 *      available.
 *   2. Exposes `onEvent(type, handler)` for other hooks to register per-event
 *      callbacks — registered handlers are automatically cleaned up when the
 *      calling component unmounts.
 *   3. Exposes `invalidate(swrKey)` so handlers can trigger SWR revalidation
 *      without importing SWR directly into every consumer hook.
 *
 * Implemented as a plain-TypeScript function (no React import) so it can be
 * unit-tested in the Jest environment without a DOM.  A React-based wrapper
 * that calls `useEffect` / `useSWR` should be written in the Next.js app layer.
 *
 * Usage (React pseudo-code):
 * ```tsx
 * const { onEvent, invalidate, streamState } = useContractEvents(token, mutate);
 *
 * useEffect(() => {
 *   return onEvent('milestone_approved', () => invalidate('/api/players/p1'));
 * }, []);
 * ```
 *
 * Related: issue #1314
 */

import {
  getEventStream,
  type ContractEventType,
  type StreamEvent,
  type StreamState,
  type Unsubscribe,
} from '../lib/eventStream';

// ─── Types ────────────────────────────────────────────────────────────────────

/** SWR-compatible mutate function — accepts any cache key. */
export type SwrMutateFn = (key: string) => void;

export interface ContractEventsDeps {
  /** JWT access token for the authenticated user, or null when logged out. */
  token: string | null;
  /**
   * SWR global mutate function.  Pass `mutate` from `useSWRConfig()` in React.
   * In tests pass a jest.fn().
   */
  mutate: SwrMutateFn;
}

export interface ContractEventsResult {
  /**
   * Register an event handler for the given event type (or `'*'` for all).
   * Returns an unsubscribe function.  Must be called inside a `useEffect`
   * so cleanup happens on unmount.
   */
  onEvent: (type: ContractEventType | '*', handler: (event: StreamEvent) => void) => Unsubscribe;
  /**
   * Trigger SWR revalidation for the given cache key.
   * Internally calls the `mutate` function passed in deps.
   */
  invalidate: (swrKey: string) => void;
  /** Current stream lifecycle state. */
  streamState: StreamState;
}

// ─── Hook implementation ──────────────────────────────────────────────────────

/**
 * Core hook logic — framework-agnostic.
 *
 * Call this inside a React `useEffect`:
 *
 * ```tsx
 * useEffect(() => {
 *   const { onEvent, invalidate } = useContractEvents({ token, mutate });
 *   const unsub = onEvent('scout_subscribed', () => invalidate('/api/scouts/sub'));
 *   return unsub;
 * }, [token]);
 * ```
 *
 * In a full React hook, wrap with `useState`/`useEffect` to track `streamState`
 * reactively.
 */
export function useContractEvents(deps: ContractEventsDeps): ContractEventsResult {
  const { token, mutate } = deps;
  const stream = getEventStream();

  // Connect / update token.
  if (token) {
    stream.connect(token);
  } else {
    // No token means logged out — do nothing (don't disconnect because the
    // stream manager persists across renders; the caller controls lifecycle).
  }

  const onEvent: ContractEventsResult['onEvent'] = (type, handler) => {
    return stream.onEvent(type, handler);
  };

  const invalidate: ContractEventsResult['invalidate'] = (swrKey) => {
    mutate(swrKey);
  };

  return {
    onEvent,
    invalidate,
    streamState: stream.state,
  };
}
