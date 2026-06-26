/**
 * fetchWithTimeout — a thin wrapper over the platform `fetch` that bounds every
 * client request with an AbortController + timeout so a vulnerable tenant on a
 * flaky borrowed phone never sees a request hang forever with no feedback.
 *
 * We use the native `AbortSignal.timeout(ms)` (no new deps) and surface a typed,
 * CATCHABLE error: a timeout/abort throws `TimeoutError` and a caller-supplied
 * signal abort throws `AbortError`. We deliberately do NOT swallow errors — the
 * caller's catch block (and the localized retry UI, a later task) must see them.
 *
 * Budgets: LLM-touching calls (intake/chat/defenses/answer/stipulation) get a
 * longer budget; everything else (cases CRUD, reminders, KB, OTP) gets a shorter
 * one. Streaming responses (POST /api/chat) need their own idle-read timeout on
 * the reader so a HALF-OPEN stream — connected but silent — cannot hang either;
 * use {@link readWithIdleTimeout} for that.
 */

/** Request timeout budgets (ms). */
export const FETCH_TIMEOUT_MS = 15_000;
/** LLM-touching calls can legitimately take longer (vision/generation). */
export const LLM_FETCH_TIMEOUT_MS = 30_000;
/** Idle-read budget for a streaming reader: max gap BETWEEN chunks. */
export const STREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * A typed, catchable timeout error. We re-throw under our own name so the UI can
 * distinguish a timeout from a generic network failure if it wants to, while
 * still being a plain `Error` (so existing `instanceof Error` checks keep
 * working). The native `AbortSignal.timeout` rejects with a DOMException named
 * "TimeoutError"; we normalize to this.
 */
export class FetchTimeoutError extends Error {
  readonly name = "FetchTimeoutError";
  /** The budget (ms) that elapsed. */
  readonly timeoutMs: number;
  constructor(timeoutMs: number, message?: string) {
    super(message ?? `Request timed out after ${timeoutMs}ms.`);
    this.timeoutMs = timeoutMs;
  }
}

export interface FetchWithTimeoutOptions extends RequestInit {
  /** Timeout budget in ms. Defaults to {@link FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Streaming responses: bound only TIME-TO-RESPONSE (the wait for headers), then
   * STOP the timeout so it can never abort the in-progress body stream. A long
   * but healthy, actively-streaming answer (e.g. a buffered Opus chat reply) must
   * not be killed mid-generation by a total-request deadline; the caller bounds
   * the stream itself with {@link readWithIdleTimeout}. Defaults false (the
   * timeout bounds the whole request — correct for small JSON responses).
   */
  streaming?: boolean;
}

/**
 * `fetch` bounded by an AbortController + timeout. On timeout it throws
 * {@link FetchTimeoutError}; any caller-supplied `signal` is honored too (its
 * abort propagates as the usual AbortError). The returned Response is otherwise
 * untouched — including a streaming `body`, so callers can read it as normal.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const { timeoutMs = FETCH_TIMEOUT_MS, streaming = false, signal: callerSignal, ...init } = options;

  if (streaming) {
    // Manual controller so we can DETACH the deadline once the response resolves.
    // AbortSignal.timeout can't be cancelled, so it would keep ticking and abort
    // the body mid-stream; here we clearTimeout as soon as headers arrive and let
    // readWithIdleTimeout bound the stream from then on.
    const controller = new AbortController();
    const signal = callerSignal
      ? anySignal([callerSignal, controller.signal])
      : controller.signal;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await fetch(input, { ...init, signal });
    } catch (err) {
      if (timedOut && !(callerSignal?.aborted ?? false)) {
        throw new FetchTimeoutError(timeoutMs);
      }
      throw err;
    } finally {
      // Headers arrived (or the fetch failed) — stop the deadline so it never
      // aborts the streaming body the caller is about to read.
      clearTimeout(timer);
    }
  }

  // Non-streaming: bound the WHOLE request (headers + body) with the native
  // timeout signal — the body is small and read immediately by the caller.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal
    ? anySignal([callerSignal, timeoutSignal])
    : timeoutSignal;

  try {
    return await fetch(input, { ...init, signal });
  } catch (err) {
    // The timeout fired: re-throw as our typed, catchable error. A caller-driven
    // abort (callerSignal) is left as-is so callers can tell the two apart.
    if (timeoutSignal.aborted && !(callerSignal?.aborted ?? false)) {
      throw new FetchTimeoutError(timeoutMs);
    }
    throw err;
  }
}

/**
 * Convenience for LLM-touching endpoints: same as {@link fetchWithTimeout} but
 * defaulting to the longer {@link LLM_FETCH_TIMEOUT_MS} budget.
 */
export function fetchLlm(
  input: RequestInfo | URL,
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  return fetchWithTimeout(input, {
    timeoutMs: LLM_FETCH_TIMEOUT_MS,
    ...options,
  });
}

/**
 * Combine multiple AbortSignals into one that aborts as soon as ANY input does.
 * (`AbortSignal.any` exists in newer runtimes but is not yet universal; this is
 * a tiny, dependency-free equivalent.)
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const onAbort = (ev: Event) => {
    controller.abort((ev.target as AbortSignal).reason);
    for (const s of signals) s.removeEventListener("abort", onAbort);
  };
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", onAbort);
  }
  return controller.signal;
}

/**
 * Read one chunk from a stream reader, but reject if no chunk arrives within
 * `idleMs`. This bounds a HALF-OPEN stream (TCP connected, server gone silent)
 * that would otherwise leave `reader.read()` pending forever, hanging the chat
 * UI with a stuck "…". Throws {@link FetchTimeoutError} on idle timeout.
 *
 * The pending `read()` is cancelled on timeout so the underlying connection is
 * torn down rather than leaked. Callers should treat a throw as a stream error
 * (catchable by the UI, not swallowed).
 */
export async function readWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleMs: number = STREAM_IDLE_TIMEOUT_MS,
): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Tear down the connection so we don't leak a half-open socket.
      void reader.cancel().catch(() => {});
      reject(new FetchTimeoutError(idleMs, `Stream stalled for ${idleMs}ms.`));
    }, idleMs);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
