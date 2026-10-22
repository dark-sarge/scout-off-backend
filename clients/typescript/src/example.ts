import { createScoutOffClient } from './index.js';

const client = createScoutOffClient({
  baseUrl: 'https://api.scoutoff.io/api',
  accessToken: 'your-access-token',
});

export async function listPlayers(region: string) {
  return client.GET('/players', {
    params: { query: { region, page: 1 } },
  });
}
