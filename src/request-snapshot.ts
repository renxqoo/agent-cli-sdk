import type { RequestAttemptEvent, RequestOptions } from "./request-contracts.js";
import { InternalError } from "./errs/index.js";

/** Preparation receives isolated JSON values, preserving the body encoder's wire result. */
export function cloneRequest(request: Readonly<RequestOptions>): RequestOptions {
  let body = request.body;
  if (body !== undefined && typeof body !== "string") {
    try {
      const encoded = JSON.stringify(body);
      if (encoded === undefined) throw new TypeError("Body has no JSON representation");
      const value: unknown = JSON.parse(encoded);
      // A raw string body and an object serialized as a JSON string have different wire bytes.
      body = typeof value === "string" ? { toJSON: () => value } : value;
    } catch (cause) {
      throw new InternalError({
        subtype: "contract_violation",
        message: "Request body is not JSON serializable",
        cause,
      });
    }
  }
  return {
    ...request,
    ...(request.query ? { query: structuredClone(request.query) } : {}),
    ...(request.headers ? { headers: { ...request.headers } } : {}),
    ...(body === undefined ? {} : { body }),
  };
}

export function cloneRequestEvent(event: Readonly<RequestAttemptEvent>): RequestAttemptEvent {
  const outcome =
    event.outcome.kind === "response"
      ? { kind: "response" as const, response: structuredClone(event.outcome.response) }
      : { kind: "network-error" as const, error: cloneFailure(event.outcome.error) };
  return {
    ...event,
    logicalRequest: cloneRequest(event.logicalRequest),
    request: cloneRequest(event.request),
    outcome,
  };
}

function cloneFailure(error: unknown): unknown {
  if (!(error instanceof Error)) return structuredClone(error);
  const descriptors = Object.getOwnPropertyDescriptors(error);
  for (const descriptor of Object.values(descriptors)) {
    if ("value" in descriptor) descriptor.value = structuredClone(descriptor.value);
  }
  const snapshot = new Error(error.message);
  Object.setPrototypeOf(snapshot, Object.getPrototypeOf(error));
  return Object.defineProperties(snapshot, descriptors);
}
