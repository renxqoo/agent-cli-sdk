import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalState, createMemoryLocalState } from "../local-state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createLocalState", () => {
  it("derives every SDK path from one app-owned root", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-cli-local-state-"));
    roots.push(root);

    const localState = createLocalState({ dir: root });

    expect(localState.kind).toBe("file");
    expect(localState.paths).toEqual({
      root: resolve(root),
      configDir: join(root, "config"),
      credentialsDir: join(root, "credentials"),
      cacheDir: join(root, "cache"),
      updatesDir: join(root, "cache", "updates"),
    });
  });

  it("uses the shared root for namespaced config and credential writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-cli-local-state-"));
    roots.push(root);
    const localState = createLocalState({ dir: root });

    await localState.store.saveConfig("crm", { clientId: "client-1" });
    await localState.store.saveCredentials("orders", { token: "secret" });

    expect(JSON.parse(readFileSync(join(localState.paths.configDir, "crm.json"), "utf8"))).toEqual({
      clientId: "client-1",
    });
    const credentialPath = join(localState.paths.credentialsDir, "orders.json");
    expect(JSON.parse(readFileSync(credentialPath, "utf8"))).toEqual({ token: "secret" });
    if (process.platform !== "win32") {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects an empty root instead of falling back to a hidden default", () => {
    expect(() => createLocalState({ dir: "  " })).toThrow("local state dir must not be empty");
  });
});

describe("createMemoryLocalState", () => {
  it("provides the same store contract without filesystem paths", async () => {
    const localState = createMemoryLocalState({ config: { crm: { clientId: "test" } } });
    expect(localState.kind).toBe("memory");
    expect(await localState.store.loadConfig("crm")).toEqual({ clientId: "test" });
    expect("paths" in localState).toBe(false);
  });
});
