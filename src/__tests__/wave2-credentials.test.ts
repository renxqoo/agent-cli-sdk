/**
 * Wave 2 regression tests — credentials subsystem:
 *   B3  — credential/config files parsed with the strict bounded parser
 *   B4  — stale .tmp files swept on fileStore construction
 *   B5  — transactCredentials serializes read-modify-write across store instances
 *   C11 — reads tolerate a missing dir and validate namespace before any side effect
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

describe("temporary credential writes", () => {
  it("preserves live and unrelated temporary files and recovers dead owned writes", async () => {
    const dir = tempDir();
    const credsDir = join(dir, "credentials");
    const configDir = join(dir, "config");
    mkdirSync(credsDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const id = "00000000-0000-4000-8000-000000000000";
    const live = join(credsDir, `orders.json.${process.pid}.${id}.tmp`);
    const dead = join(credsDir, `orders.json.99999999.${id}.tmp`);
    const unrelated = join(configDir, "user.tmp");
    writeFileSync(live, "live");
    writeFileSync(dead, "dead");
    writeFileSync(unrelated, "user");
    const store = fileStore({ dir });
    expect(existsSync(dead)).toBe(true);
    await store.saveCredentials("orders", { token: "new" });
    expect(existsSync(live)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(dead)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B5: transactCredentials serializes read-modify-write
// ---------------------------------------------------------------------------

describe("B5: transactCredentials serializes the refresh transaction", () => {
  it("two store instances on the same dir never overlap (cross-process model)", async () => {
    const dir = tempDir();
    const storeA = fileStore({ dir });
    const storeB = fileStore({ dir });

    let active = 0;
    let maxOverlap = 0;
    const txn = async (store: ReturnType<typeof fileStore>) =>
      store.transactCredentials("orders", async () => {
        active++;
        maxOverlap = Math.max(maxOverlap, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      });

    await Promise.all([txn(storeA), txn(storeB)]);
    expect(maxOverlap).toBe(1); // serialized, never concurrent
  });

  it("transactCredentials rejects an invalid namespace before locking", async () => {
    const store = fileStore({ dir: tempDir() });
    await expect(store.transactCredentials("../escape", async () => 1)).rejects.toMatchObject({
      subtype: "invalid_config",
    });
  });

  it("memoryStore.transactCredentials serializes in-process", async () => {
    const store = memoryStore();
    let active = 0;
    let maxOverlap = 0;
    const txn = () =>
      store.transactCredentials("orders", async () => {
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
  it("a contended transactCredentials rejects once lockTimeoutMs elapses", async () => {
    const dir = tempDir();
    const storeA = fileStore({ dir });
    const storeB = fileStore({ dir, lockTimeoutMs: 100 });
    let releaseA!: () => void;
    const holdA = storeA.transactCredentials("ns", () => new Promise<void>((r) => (releaseA = r)));
    await new Promise((r) => setTimeout(r, 30)); // let A acquire the lock

    await expect(storeB.transactCredentials("ns", async () => "x")).rejects.toThrow(
      /lock|acquire/i,
    );

    releaseA();
    await holdA;
  });
});
