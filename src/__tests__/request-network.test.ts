import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createFetchAdapter } from "../request.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

describe("real HTTP request lifecycle", () => {
  it("applies the deadline while reading a response body after headers arrive", async () => {
    let headersSent = false;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      headersSent = true;
      // Leave the body open so only the SDK deadline terminates the request.
    });
    const url = await listen(server);
    try {
      const adapter = createFetchAdapter({ timeout: 100 });
      await expect(adapter.send({ method: "GET", path: url })).resolves.toMatchObject({
        kind: "network-error",
        error: { category: "network", subtype: "timeout", retryable: true },
      });
      expect(headersSent).toBe(true);
    } finally {
      await close(server);
    }
  });

  it("cancels an in-flight fetch with an arbitrary caller reason", async () => {
    const controller = new AbortController();
    const server = createServer(() => controller.abort(new Error("private cancellation reason")));
    const url = await listen(server);
    try {
      const adapter = createFetchAdapter();
      const outcome = await adapter.send({ method: "GET", path: url, signal: controller.signal });
      expect(outcome).toMatchObject({
        kind: "network-error",
        error: { subtype: "cancelled", message: "Request cancelled by caller", retryable: false },
      });
    } finally {
      await close(server);
    }
  });
});
