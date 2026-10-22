# ScoutOff TypeScript API client

`@scoutoff/api-client` is the versioned TypeScript client for the ScoutOff
REST API. Its request types are generated from the repository's canonical
OpenAPI document; the package version matches `info.version` in
`src/openapi.yaml`.

## Install and use

Install `@scoutoff/api-client` from the package registry after its first
release. To build and use the checked-in package locally, run
`npm run build:client`, then install it with `npm install ./clients/typescript`.

```ts
import { createScoutOffClient } from '@scoutoff/api-client';

const client = createScoutOffClient({
  baseUrl: 'https://api.scoutoff.io/api',
  accessToken: 'your-access-token',
});

const { data, error } = await client.GET('/players', {
  params: { query: { region: 'EU', page: 1 } },
});

if (error) {
  throw new Error(`Player request failed: ${JSON.stringify(error)}`);
}
```

Set `baseUrl` to the API origin plus a supported mount (`/api`, `/api/v1`, or
`/api/v2`). `accessToken` is optional; use it for routes protected by bearer
authentication. Standard `openapi-fetch` options, including custom headers and
a custom `fetch` implementation, are also supported.

## Regenerate and version

From the repository root:

```sh
npm run build:openapi
npm run build:client
npm run validate:client
```

`build:client` regenerates `src/schema.ts`, synchronizes this package's
version with the OpenAPI `info.version`, and builds distributable JavaScript
and declarations into `dist/`. `dist/` is intentionally generated during
packing and is not committed.
