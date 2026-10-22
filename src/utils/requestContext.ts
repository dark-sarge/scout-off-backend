import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  correlationId: string;
  /** AbortSignal attached to this request. Aborted on timeout or client disconnect. */
  signal?: AbortSignal;
}

/**
 * AsyncLocalStorage that carries per-request context (correlationId, AbortSignal)
 * implicitly through the entire async call chain — no manual parameter threading.
 *
 * Usage:
 *   - Set by correlationId middleware via requestContext.run(...)
 *   - Read anywhere via getCorrelationId() / getRequestSignal()
 *   - Background jobs have no active store, so helpers return undefined
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Returns the correlationId for the current async context, or undefined outside a request. */
export function getCorrelationId(): string | undefined {
  return requestContext.getStore()?.correlationId;
}

/**
 * Returns the AbortSignal for the current request, or undefined when called
 * outside a request context (background jobs, tests without middleware).
 *
 * Pass this to fetch/axios/pg calls so they are cancelled when the client
 * disconnects or the request times out.
 */
export function getRequestSignal(): AbortSignal | undefined {
  return requestContext.getStore()?.signal;
}
