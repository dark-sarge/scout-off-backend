import { Request, Response, NextFunction } from 'express';
import config from '../config';
import { ErrorCode } from '../utils/errorCodes';
import { requestContext } from '../utils/requestContext';
import { logger } from '../utils/logger';

/**
 * Returns an Express middleware that:
 *   1. Creates an AbortController for the request and stores the signal in the
 *      AsyncLocalStorage context so downstream services can check/propagate it.
 *   2. Aborts the controller (and returns 504) when `ms` elapses without a response.
 *   3. Aborts the controller when the client disconnects before a response is sent.
 *   4. Guards the timeout response against ERR_HTTP_HEADERS_SENT (no-ops if headers
 *      were already sent by the route handler).
 *
 * Pass `0` to disable the timeout (useful for endpoints that return 202 immediately
 * and run a background job — the HTTP leg completes immediately so no timeout is needed).
 *
 * Timeout responses use 504 REQUEST_TIMEOUT with a `Retry-After: 1` hint so clients
 * know the request may be safe to retry (idempotent callers should use the
 * idempotency-key mechanism to avoid double-charging).
 *
 * @param ms  Timeout in milliseconds. 0 = no timeout.
 */
export function createTimeout(ms: number) {
  return function timeoutMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (ms === 0) {
      next();
      return;
    }

    const controller = new AbortController();

    // Inject signal into the running AsyncLocalStorage context so downstream
    // code (stellar.ts, ipfs.ts, axios calls) can read it via getRequestSignal().
    const store = requestContext.getStore();
    if (store) {
      store.signal = controller.signal;
    }

    const sendTimeout = () => {
      controller.abort();
      if (res.headersSent) {
        // Route handler already responded — just log to avoid confusing double-send.
        logger.debug(
          `[timeout] timer fired after headers sent for ${req.method} ${req.path} — no-op`,
        );
        return;
      }
      res.setHeader('Retry-After', '1');
      res.status(503).json({
        success: false,
        error: 'Request timed out',
        code: ErrorCode.REQUEST_TIMEOUT,
      });
    };

    const timer = setTimeout(sendTimeout, ms);

    // Abort on client disconnect (before a response is sent — normal close after
    // res.end() is not a disconnect we want to abort on).
    const onClose = () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    };
    req.on('close', onClose);

    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener('close', onClose);
    };

    res.on('finish', cleanup);
    res.on('close', cleanup);

    next();
  };
}

/**
 * Default request timeout middleware.
 * Uses REQUEST_TIMEOUT_MS from config (default 30 s).
 *
 * Applied globally in app.ts. Individual routes that need a different timeout
 * should prepend createTimeout(ms) before their handler.
 */
export const requestTimeout = createTimeout(config.requestTimeoutMs);
