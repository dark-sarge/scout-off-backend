/**
 * usePlayerMilestones
 *
 * Event-driven hook that invalidates a player's milestone cache when
 * relevant SSE events arrive.
 *
 * Previous behaviour (#1314):
 *   - Polled GET /api/players/:playerId/milestones every N seconds.
 *
 * New behaviour:
 *   - Listens for `milestone_submitted` and `milestone_approved` events.
 *   - Calls SWR `mutate` immediately when an event matching the player arrives.
 *   - Falls back to polling at the health-appropriate interval.
 *   - Also invalidates the player profile key on `milestone_approved` (since
 *     the progress tier changes).
 *
 * Implemented as plain TypeScript for testability in Jest.
 *
 * Related: issue #1314
 */

import { useContractEvents, type ContractEventsDeps } from './useContractEvents';
import { streamHealthFromState, type StreamHealth } from './useStreamHealth';
import { getEventStream } from '../lib/eventStream';

// ─── Cache key helpers ────────────────────────────────────────────────────────

/** SWR key for a player's milestones list. */
export function milestonesKey(playerId: string): string {
  return `/api/players/${playerId}/milestones`;
}

/** SWR key for a player's profile. */
export function playerKey(playerId: string): string {
  return `/api/players/${playerId}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlayerMilestonesDeps extends ContractEventsDeps {
  /** ID of the player whose milestones to track. */
  playerId: string | null;
}

export interface PlayerMilestonesResult {
  /** Recommended SWR refreshInterval. */
  pollIntervalMs: number;
  /** Stream health info. */
  health: StreamHealth;
  /** SWR cache key for the milestones list. */
  milestonesSwrKey: string | null;
  /** SWR cache key for the player profile. */
  playerSwrKey: string | null;
}

// ─── Hook implementation ──────────────────────────────────────────────────────

/**
 * Wire up event-driven invalidation for a player's milestones.
 *
 * Usage (React pseudo-code):
 * ```tsx
 * const { data: milestones, mutate } = useSWR(milestonesSwrKey, fetcher,
 *   { refreshInterval: pollIntervalMs });
 * const { pollIntervalMs, milestonesSwrKey } = usePlayerMilestones({
 *   token, mutate, playerId,
 * });
 * ```
 */
export function usePlayerMilestones(deps: PlayerMilestonesDeps): PlayerMilestonesResult {
  const { playerId } = deps;
  const { onEvent, invalidate } = useContractEvents(deps);
  const health = streamHealthFromState(getEventStream().state);

  const mKey = playerId ? milestonesKey(playerId) : null;
  const pKey = playerId ? playerKey(playerId) : null;

  if (mKey && pKey && playerId) {
    // New milestone submitted — refresh the pending list.
    onEvent('milestone_submitted', (event) => {
      if (event.payload.player_id === playerId) {
        invalidate(mKey);
      }
    });

    // Milestone approved — refresh both milestones and player profile (tier may change).
    onEvent('milestone_approved', (event) => {
      if (event.payload.player_id === playerId) {
        invalidate(mKey);
        invalidate(pKey);
      }
    });
  }

  return {
    pollIntervalMs: health.pollIntervalMs,
    health,
    milestonesSwrKey: mKey,
    playerSwrKey: pKey,
  };
}
