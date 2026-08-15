import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, memoryStore } from "../credentials/config-store.js";
import type { ConfigStore } from "../credentials/types.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const factories: Array<[string, () => ConfigStore]> = [
  ["memory", () => memoryStore()],
  [
    "file",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "rxcli-store-"));
      temporaryDirectories.push(directory);
      return fileStore({ dir: directory });
    },
  ],
];

describe.each(factories)("ConfigStore conformance: %s", (_name, createStore) => {
  it.each(["", ".", "..", "../escape", "two words", "_private", "UPPER"])(
    "rejects invalid namespace %j for every operation",
    async (namespace) => {
      const store = createStore();
      await expect(store.loadCredentials(namespace)).rejects.toMatchObject({
        category: "config",
        subtype: "invalid_config",
      });
      await expect(store.saveCredentials(namespace, {})).rejects.toMatchObject({
        category: "config",
        subtype: "invalid_config",
      });
      await expect(store.clearCredentials(namespace)).rejects.toMatchObject({
        category: "config",
        subtype: "invalid_config",
      });
      await expect(store.loadConfig(namespace)).rejects.toMatchObject({
        category: "config",
        subtype: "invalid_config",
      });
      await expect(store.saveConfig(namespace, {})).rejects.toMatchObject({
        category: "config",
        subtype: "invalid_config",
      });
    },
  );

  it("uses JSON serialization semantics and isolates loaded values", async () => {
    const store = createStore();
    const input: Record<string, unknown> = {
      token: "secret",
      omitted: undefined,
      notANumber: Number.NaN,
      nested: { date: new Date("2024-01-01T00:00:00.000Z") },
      array: [undefined, 1],
    };

    await store.saveCredentials("orders", input);
    input.token = "mutated";
    const first = await store.loadCredentials("orders");
    expect(first).toEqual({
      token: "secret",
      notANumber: null,
      nested: { date: "2024-01-01T00:00:00.000Z" },
      array: [null, 1],
    });
    if (first) first.token = "tampered";
    expect((await store.loadCredentials("orders"))?.token).toBe("secret");
  });

  it("rejects data that JSON cannot serialize", async () => {
    const store = createStore();
    await expect(store.saveCredentials("orders", { invalid: BigInt(1) })).rejects.toMatchObject({
      category: "config",
      subtype: "invalid_config",
    });
  });

  it("replaces the full config document per namespace", async () => {
    const store = createStore();
    await store.saveConfig("crm", { clientId: "one", removed: true });
    await store.saveConfig("crm", { clientId: "two" });
    expect(await store.loadConfig("crm")).toEqual({ clientId: "two" });
  });

  it("isolates config documents across namespaces", async () => {
    const store = createStore();
    await store.saveConfig("crm", { clientId: "crm-client" });
    await store.saveConfig("cordys", { clientId: "cordys-client" });
    expect(await store.loadConfig("crm")).toEqual({ clientId: "crm-client" });
    expect(await store.loadConfig("cordys")).toEqual({ clientId: "cordys-client" });
    expect(await store.loadConfig("other")).toEqual({});
  });
});
