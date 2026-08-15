/** Local OAuth callback server with a pure, independently testable request boundary. */
import { createServer, type Server } from "node:http";
import { InternalError, NetworkError } from "../errs/index.js";

export type CallbackResult =
  | { kind: "success"; code: string }
  | { kind: "error"; error: "state_mismatch" | "invalid_callback" | string };

export interface CallbackEvaluation {
  status: number;
  html: string;
  /** Undefined means the listener must remain open (for example favicon probes). */
  result?: CallbackResult;
}

export interface CallbackHandle {
  result: Promise<CallbackResult>;
  redirectUri: string;
  close(): void;
}

const SUCCESS_HTML =
  "<html><body><h2>✓ Login successful</h2><p>You can close this tab and return to the CLI.</p></body></html>";
const FAILURE_HTML =
  "<html><body><h2>Login failed</h2><p>Return to the CLI for details.</p></body></html>";
const NOT_FOUND_HTML = "<html><body><h2>Not found</h2></body></html>";

/** Evaluate one HTTP request without opening a socket. */
export function evaluateCallbackRequest(
  method: string | undefined,
  requestUrl: string,
  expectedState: string,
): CallbackEvaluation {
  if (method !== "GET") return { status: 405, html: NOT_FOUND_HTML };

  const url = new URL(requestUrl, "http://127.0.0.1");
  if (url.pathname !== "/callback") return { status: 404, html: NOT_FOUND_HTML };

  const state = url.searchParams.get("state");
  if (state !== expectedState) {
    return {
      status: 400,
      html: FAILURE_HTML,
      result: { kind: "error", error: "state_mismatch" },
    };
  }

  const providerError = url.searchParams.get("error");
  if (providerError) {
    return {
      status: 400,
      html: FAILURE_HTML,
      result: { kind: "error", error: providerError },
    };
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return {
      status: 400,
      html: FAILURE_HTML,
      result: { kind: "error", error: "invalid_callback" },
    };
  }

  return { status: 200, html: SUCCESS_HTML, result: { kind: "success", code } };
}

export function waitForCallback(options: {
  port?: number;
  timeoutMs: number;
  expectedState: string;
}): Promise<CallbackHandle> {
  return new Promise((resolveSetup, rejectSetup) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resultResolve: ((value: CallbackResult) => void) | undefined;
    let resultReject: ((error: unknown) => void) | undefined;
    let settled = false;
    const result = new Promise<CallbackResult>((resolve, reject) => {
      resultResolve = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      resultReject = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
    });

    const server: Server = createServer((request, response) => {
      const evaluation = evaluateCallbackRequest(
        request.method,
        request.url ?? "/",
        options.expectedState,
      );
      response.writeHead(evaluation.status, { "content-type": "text/html; charset=utf-8" });
      response.end(evaluation.html);

      if (!evaluation.result) return;
      if (timer) clearTimeout(timer);
      server.close();
      resultResolve?.(evaluation.result);
    });

    const close = (): void => {
      if (timer) clearTimeout(timer);
      server.close();
      // C5: settle the exposed promise so a caller that awaits `result` and then
      // closes cannot hang forever waiting for a callback that will never arrive.
      resultReject?.(
        new InternalError({ subtype: "contract_violation", message: "callback listener closed" }),
      );
    };

    server.on("error", (error) => {
      resultReject?.(error);
      rejectSetup(error);
    });

    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      timer = setTimeout(() => {
        server.close();
        resultReject?.(
          new NetworkError({
            subtype: "timeout",
            message: `callback timed out after ${options.timeoutMs}ms`,
            retryable: true,
          }),
        );
      }, options.timeoutMs);

      resolveSetup({ result, redirectUri, close });
    });
  });
}
