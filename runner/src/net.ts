// Network guards shared by every outbound call. buzz-app's `nodeClient` calls
// the global `fetch` with no deadline; it is reused unmodified so tool
// behavior matches Desktop, so the deadline is added here, once, for the
// whole process. Retries live here too, so every caller gets the same
// bounded, jittered backoff.
import {
  HTTP_MEDIA_TIMEOUT_MS,
  HTTP_TIMEOUT_MS,
  RETRY_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_JITTER,
  RETRY_MAX_MS,
} from "./constants";
import { errorMessage } from "./errors";
import type { Logger } from "./log";

const MEDIA_PATH = /\/(media|upload)(\/|$)/;

/** Wraps `fetch` so a call without its own signal times out. Blob transfers
 * get a longer deadline than JSON reads and writes. */
export function installFetchDeadline() {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    if (init.signal) return original(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const timeout = MEDIA_PATH.test(new URL(url).pathname) ? HTTP_MEDIA_TIMEOUT_MS : HTTP_TIMEOUT_MS;
    return original(input, { ...init, signal: AbortSignal.timeout(timeout) });
  };
}

/** `base * 2^attempt`, capped, with ±jitter so agents reconnecting together
 * do not hit the relay in lockstep. */
export function backoff(attempt: number, base: number, max: number, jitter = RETRY_JITTER) {
  const raw = Math.min(max, base * 2 ** attempt);
  return Math.round(raw * (1 - jitter + Math.random() * 2 * jitter));
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });

/** Runs an idempotent operation up to RETRY_ATTEMPTS times while
 * `transient` says the failure may pass. Each retry and the final failure
 * are logged with the attempt number and elapsed time. */
export async function retry<T>(
  operation: string,
  run: () => Promise<T>,
  log: Logger,
  transient: (error: unknown) => boolean = isTransient,
): Promise<T> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const last = attempt + 1 >= RETRY_ATTEMPTS || !transient(error);
      const fields = { operation, attempt: attempt + 1, elapsedMs: Date.now() - started, error };
      if (last) {
        log.warn("operation failed", fields);
        throw error;
      }
      const delay = backoff(attempt, RETRY_BASE_MS, RETRY_MAX_MS);
      log.info("operation retry", { ...fields, delayMs: delay });
      await sleep(delay);
    }
  }
}

/** Network failures, timeouts and the statuses buzz-acp retries
 * (429/502/503/504). nodeClient reports a refusal as "<status> <body>". */
export function isTransient(error: unknown) {
  const message = errorMessage(error);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return true;
  if (error instanceof TypeError) return true; // fetch failed: DNS, reset, refused
  return /^(429|502|503|504)\b/.test(message);
}

/** Rejects when `work` has not settled within `ms`. The work itself is not
 * cancelled; callers whose work holds a resource release it on its own. */
export function withTimeout<T>(work: Promise<T>, ms: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${operation} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
