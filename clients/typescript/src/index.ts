import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './schema.js';

export type { paths } from './schema.js';

export interface ScoutOffClientOptions extends Omit<ClientOptions, 'baseUrl' | 'headers'> {
  baseUrl: string;
  accessToken?: string;
  headers?: HeadersInit;
}

export function createScoutOffClient(options: ScoutOffClientOptions) {
  const { accessToken, headers, ...clientOptions } = options;
  const requestHeaders = new Headers(headers);
  if (accessToken) requestHeaders.set('Authorization', `Bearer ${accessToken}`);

  return createClient<paths>({
    ...clientOptions,
    headers: requestHeaders,
  });
}
