import { ConfigError, NetworkError } from "./errs/index.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Timer limits are identical in Node and Bun; reject overflow instead of timing out in 1 ms. */
export function validateRequestTimeout(timeout: number): void {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new ConfigError({
      subtype: "invalid_config",
      message: "Request timeout must be an integer from 1 to 2147483647 milliseconds",
    });
  }
}

export function cancellationError(signal: AbortSignal): NetworkError {
  return new NetworkError({
    subtype: "cancelled",
    message: "Request cancelled by caller",
    retryable: false,
    cause: signal.reason,
  });
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError(signal);
}

/** Stop waiting without cancelling shared work, such as a singleflight token refresh. */
export async function withCancellation<T>(
  signal: AbortSignal | undefined,
  operation: Promise<T>,
): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener("abort", cancel);
      reject(cancellationError(signal));
    };
    signal.addEventListener("abort", cancel, { once: true });
    // Always observe the started work, even if the signal has already aborted.
    // This preserves audit delivery and prevents late refresh failures from becoming unhandled.
    operation.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
    if (signal.aborted) cancel();
  });
}
