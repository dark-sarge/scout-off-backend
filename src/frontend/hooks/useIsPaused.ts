/**
 * useIsPaused
 *
 * Event-driven hook that tracks whether the ScoutOff Soroban contract is
 * in the paused (circuit-breaker) state.
 *
 * Previous behaviour (#1314):
 *   - Polled GET /api/contract/health every N seconds.
 *
 * New behaviour:
 *   - Registers `onEvent('*', handler)` and listens for a `contract_paused` /
 *     `contract_unpaused` field in any event payload.
 *   - Falls back to polling at `pollIntervalMs` from useStreamHealth (30 s
 *     when stream is down, 5 min when healthy).
 *   - When a `pause_contract` or `unpause_contract` admin action event arrives,
 *     calls `invalidate(CONTRACT_HEALTH_KEY)` to force SWR revalidation
 *     immediately rather than waiting for the interval.
 *
 * The hook is intentionally thin — it only adds the event wiring on top of
 * a standard SWR fetch.  The actual HTTP call and data normalisation stay in
 * the SWR fetcher (not defined here — defined in the Next.js page layer).
 *
 * Implemented as a plain TypeScript function so it can be tested in Jest
 * without a browser environment.
 *
 * Related: issue #1314
 */

import { useContractEvents, type ContractEventsDeps, type SwrMutateFn } from './useContractEvents';
import { streamHealthFromState, type StreamHealth } from './useStreamHealth';
import { getEventStream } from '../lib/eventStream';

// ─── Constants ────────────────────────────────────────────────────────────────

/** SWR cache key for the contract health/paused endpoint. */
export const CONTRACT_HEALTH_KEY = '/api/contract/health';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IsPausedDeps extends ContractEventsDeps {
  /** Current `isPaused` value from the SWR cache (undefined while loading). */
  isPaused: boolean | undefined;
}

export interface IsPausedResult {
  /**
   * Recommended SWR refreshInterval based on stream health.
   * Pass to `useSWR(CONTRACT_HEALTH_KEY, fetcher, { refreshInterval })`.
   */
  pollIntervalMs: number;
  /** Stream health info for the caller. */
  health: StreamHealth;
}

// ─── Hook implementation ──────────────────────────────────────────────────────

/**
 * Wire up event-driven invalidation for the contract paused state.
 *
 * Returns the SWR refresh interval to use as a fallback.
 *
 * Usage (React pseudo-code):
 * ```tsx
 * const { data: contractHealth, mutate } = useSWR(CONTRACT_HEALTH_KEY, fetcher);
 * const { pollIntervalMs } = useIsPaused({ token, mutate, isPaused: contractHealth?.paused });
 * // Also pass pollIntervalMs to useSWR as refreshInterval.
 * ```
 *
 * @param deps.token      JWT for the EventStream connection.
 * @param deps.mutate     SWR global mutate.
 * @param deps.isPaused   Current cached value (for context only; not mutated here).
 */
export function useIsPaused(deps: IsPausedDeps): IsPausedResult {
  const { onEvent, invalidate } = useContractEvents(deps);
  const health = streamHealthFromState(getEventStream().state);

  // Any admin action that touches the contract state should trigger a refetch.
  // The backend emits these as part of admin multi-sig execution payloads.
  onEvent('*', (event) => {
    const p = event.payload;
    if (
      p.action === 'pause_contract' ||
      p.action === 'unpause_contract' ||
      p.paused !== undefined
    ) {
      invalidate(CONTRACT_HEALTH_KEY);
    }
  });

  return {
    pollIntervalMs: health.pollIntervalMs,
    health,
  };
}

/**
 * Factory for use in tests — takes explicit deps rather than reading the
 * singleton stream.
 */
export function makeUseIsPaused(
  mutate: SwrMutateFn,
  token: string | null,
): IsPausedResult {
  return useIsPaused({ mutate, token, isPaused: undefined });
}
