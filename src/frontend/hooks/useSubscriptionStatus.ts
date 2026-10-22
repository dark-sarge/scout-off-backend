/**
 * useSubscriptionStatus
 *
 * Event-driven hook that tracks a scout's subscription status.
 *
 * Previous behaviour (#1314):
 *   - Polled GET /api/scouts/:wallet/subscription every N seconds.
 *
 * New behaviour:
 *   - Listens for `scout_subscribed` events on the SSE stream and immediately
 *     calls SWR `mutate` to revalidate the subscription cache key.
 *   - Falls back to polling at the stream-health-appropriate interval.
 *
 * The hook wires the SSE event → SWR invalidation path.  The actual fetcher
 * and SWR call remain in the Next.js component layer.
 *
 * Implemented as a plain TypeScript function for testability.
 *
 * Related: issue #1314
 */

import { useContractEvents, type ContractEventsDeps } from './useContractEvents';
import { streamHealthFromState, type StreamHealth } from './useStreamHealth';
import { getEventStream } from '../lib/eventStream';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Build the SWR cache key for a scout's subscription.
 * Mirrors the REST endpoint path.
 */
export function subscriptionKey(wallet: string): string {
  return `/api/scouts/${wallet}/subscription`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SubscriptionStatusDeps extends ContractEventsDeps {
  /** The scout's Stellar wallet address. */
  wallet: string | null;
}

export interface SubscriptionStatusResult {
  /** Recommended SWR refreshInterval based on stream health. */
  pollIntervalMs: number;
  /** Stream health info. */
  health: StreamHealth;
  /** SWR cache key for this wallet's subscription. */
  swrKey: string | null;
}

// ─── Hook implementation ──────────────────────────────────────────────────────

/**
 * Wire up event-driven invalidation for a scout's subscription status.
 *
 * Usage (React pseudo-code):
 * ```tsx
 * const { data: sub, mutate } = useSWR(swrKey, fetcher, { refreshInterval: pollIntervalMs });
 * const { pollIntervalMs, swrKey } = useSubscriptionStatus({ token, mutate, wallet });
 * ```
 */
export function useSubscriptionStatus(deps: SubscriptionStatusDeps): SubscriptionStatusResult {
  const { wallet } = deps;
  const { onEvent, invalidate } = useContractEvents(deps);
  const health = streamHealthFromState(getEventStream().state);

  const key = wallet ? subscriptionKey(wallet) : null;

  if (key) {
    onEvent('scout_subscribed', (event) => {
      // Only invalidate for the authenticated wallet's events.
      // (Server-side filtering already ensures this, but belt-and-suspenders.)
      const p = event.payload;
      if (!wallet || p.scout === wallet || p.wallet === wallet) {
        invalidate(key);
      }
    });
  }

  return {
    pollIntervalMs: health.pollIntervalMs,
    health,
    swrKey: key,
  };
}
