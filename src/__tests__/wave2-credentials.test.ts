/**
 * Wave 2 regression tests — credentials subsystem:
 *   B3  — credential/config files parsed with the strict bounded parser
 *   B4  — stale .tmp files swept on fileStore construction
 *   B5  — withLock serializes read-modify-write across store instances
 *   C11 — reads tolerate a missing dir and validate namespace before any side effect
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, memoryStore } from "../credentials/config-store.js";
import { decodeJsonDocument } from "../credentials/codec.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "rxcli-wave2-"));
  dirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// B3: strict parse of credential/config documents
// ---------------------------------------------------------------------------

describe("B3: decodeJsonDocument uses the strict bounded parser", () => {
  it("rejects a document with duplicate keys", () => {
    expect(() => decodeJsonDocument('{ "a": 1, "a": 2 }', "creds")).toThrow(
      /Invalid JSON document/,
    );
  });

  it("rejects an unsafe key", () => {
    expect(() => decodeJsonDocument('{ "__proto__": {} }', "creds")).toThrow(
      /Invalid JSON document/,
    );
  });

  it("rejects a non-object root", () => {
    expect(() => decodeJsonDocument("[1, 2, 3]", "creds")).toThrow(/Invalid JSON document/);
  });

  it("accepts a normal object", () => {
    expect(decodeJsonDocument('{ "token": "abc" }', "creds")).toEqual({ token: "abc" });
  });
});

describe("B3: fileStore loadCredentials rejects a malformed credential file", () => {
  it("throws ConfigError (invalid_config) for duplicate-key JSON", async () => {
    const dir = tempDir();
    const credsDir = join(dir, "credentials");
    mkdirSync(credsDir, { recursive: true });
    // write a tampered credential file directly (bypass the strict encoder)
    writeFileSync(join(credsDir, "orders.json"), '{"token":"a","token":"b"}');
    const store = fileStore({ dir });
    await expect(store.loadCredentials("orders")).rejects.toMatchObject({
      category: "config",
      subtype: "invalid_config",
    });
  });
});

// ---------------------------------------------------------------------------
// B4: stale .tmp files swept on construction
// ---------------------------------------------------------------------------

describe("B4: fileStore sweeps stale .tmp files on construction", () => {
  it("removes leftover .tmp files in credentials and config", () => {
    const dir = tempDir();
    // pre-create the dir layout + stale temps before constructing the store
    const credsDir = join(dir, "credentials");
    const configDir = join(dir, "config");
    mkdirSync(credsDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(credsDir, "orders.json.123.abc.tmp"), "secret-leak");
    writeFileSync(join(configDir, "crm.json.456.def.tmp"), "leak");
    // sanity
    expect(existsSync(join(credsDir, "orders.json.123.abc.tmp"))).toBe(true);

    fileStore({ dir }); // construction sweeps

    const remaining = readdirSync(credsDir).concat(readdirSync(configDir));
    expect(remaining.some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B5: withLock serializes read-modify-write
// ---------------------------------------------------------------------------

describe("B5: withLock serializes the refresh transaction", () => {
  it("two store instances on the same dir never overlap (cross-process model)", async () => {
    const dir = tempDir();
    const storeA = fileStore({ dir });
    const storeB = fileStore({ dir });

    let active = 0;
    let maxOverlap = 0;
    const txn = async (store: ReturnType<typeof fileStore>) =>
      store.withLock("orders", async () => {
        active++;
        maxOverlap = Math.max(maxOverlap, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      });

    await Promise.all([txn(storeA), txn(storeB)]);
    expect(maxOverlap).toBe(1); // serialized, never concurrent
  });

  it("withLock rejects an invalid namespace before locking", async () => {
    const store = fileStore({ dir: tempDir() });
    await expect(store.withLock("../escape", async () => 1)).rejects.toMatchObject({
      subtype: "invalid_config",
    });
  });

  it("memoryStore.withLock serializes in-process", async () => {
    const store = memoryStore();
    let active = 0;
    let maxOverlap = 0;
    const txn = () =>
      store.withLock("orders", async () => {
        active++;
        maxOverlap = Math.max(maxOverlap, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      });
    await Promise.all([txn(), txn(), txn()]);
    expect(maxOverlap).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C11: reads tolerate missing dir; namespace validated before side effects
// ---------------------------------------------------------------------------

describe("C11: read paths have no filesystem side effects", () => {
  it("loadCredentials returns null without creating the directory", async () => {
    const dir = tempDir();
    rmSync(dir, { recursive: true, force: true });
    dirs.push(dir);
    const store = fileStore({ dir });
    await expect(store.loadCredentials("orders")).resolves.toBeNull();
    expect(existsSync(dir)).toBe(false); // no dir created on a pure read
  });

  it("loadConfig returns {} without creating the directory", async () => {
    const dir = tempDir();
    rmSync(dir, { recursive: true, force: true });
    dirs.push(dir);
    const store = fileStore({ dir });
    await expect(store.loadConfig("orders")).resolves.toEqual({});
    expect(existsSync(dir)).toBe(false);
  });

  it("an invalid namespace is rejected before any directory is created", async () => {
    const dir = tempDir();
    rmSync(dir, { recursive: true, force: true });
    dirs.push(dir);
    const store = fileStore({ dir });
    await expect(store.loadCredentials("../escape")).rejects.toMatchObject({
      subtype: "invalid_config",
    });
    expect(existsSync(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fileStore lockTimeoutMs option
// ---------------------------------------------------------------------------

describe("fileStore lockTimeoutMs option", () => {
  it("a contended withLock rejects once lockTimeoutMs elapses", async () => {
    const dir = tempDir();
    const storeA = fileStore({ dir });
    const storeB = fileStore({ dir, lockTimeoutMs: 100 });
    let releaseA!: () => void;
    const holdA = storeA.withLock("ns", () => new Promise<void>((r) => (releaseA = r)));
    await new Promise((r) => setTimeout(r, 30)); // let A acquire the lock

    await expect(storeB.withLock("ns", async () => "x")).rejects.toThrow(/lock|acquire/i);

    releaseA();
    await holdA;
  });
});
