import { createHash } from "node:crypto";
import type { IdentityHint } from "./types.js";

/** Existing documents get a deterministic identity until the next successful refresh persists it. */
export function oauthSessionId(credentials: Record<string, unknown>): string {
  if (typeof credentials.sessionId === "string" && credentials.sessionId)
    return credentials.sessionId;
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(credentials).toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");
}

export function oauthIdentity(credentials: Record<string, unknown>): IdentityHint | null {
  if (credentials.authMethod === "client_credentials") return { identity: "bot" };
  if (!credentials.user || typeof credentials.user !== "object") return null;
  const user = credentials.user as Record<string, unknown>;
  return {
    identity: "user",
    ...(typeof user.userId === "string" ? { userId: user.userId } : {}),
    ...(typeof user.name === "string" ? { name: user.name } : {}),
  };
}
