#!/usr/bin/env npx ts-node

import 'dotenv/config';
import {
  closeDb,
  getPlayersMissingOnChainId,
  initDb,
  setPlayerOnChainId,
} from '../src/db';
import { queryOnChainPlayerId } from '../src/services/stellar';

const BATCH_SIZE = 100;

async function main(): Promise<void> {
  await initDb();
  let afterPlayerId = '';
  let linked = 0;
  let pending = 0;

  try {
    for (;;) {
      const players = await getPlayersMissingOnChainId(afterPlayerId, BATCH_SIZE);
      if (players.length === 0) break;

      for (const player of players) {
        const onChainPlayerId = await queryOnChainPlayerId(player.wallet);
        if (onChainPlayerId === null) {
          pending += 1;
        } else {
          await setPlayerOnChainId(player.player_id, onChainPlayerId);
          linked += 1;
        }
      }
      afterPlayerId = players[players.length - 1].player_id;
    }

    // eslint-disable-next-line no-console
    console.info(`Player ID backfill complete: linked=${linked} pending=${pending}`);
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`Player ID backfill failed: ${message}`);
  process.exitCode = 1;
});