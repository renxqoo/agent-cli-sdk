import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdateNotifier, defineCliApp, defineCommand, errs } from "../index.js";
import { createLocalState, type FileLocalState } from "../local-state.js";
import type { Plugin } from "../types.js";

let cacheRoot = "";
let stdout = "";
let stderr = "";
let registry: Server | undefined;
let localState: FileLocalState;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "rxcli-update-"));
  localState = createLocalState({ dir: cacheRoot });
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NO_UPDATE_NOTIFIER;
  process.exitCode = undefined;
  registry?.close();
  registry = undefined;
  rmSync(cacheRoot, { recursive: true, force: true });
});

describe("cached update notifier", () => {
  it("keeps stdout parseable and emits one escaped system message on stderr", async () => {
    seedCache("@scope/my-cli", {
      latest: "2.0.0",
      checkedAt: Date.now(),
    });
    const app = await createApp([
      createUpdateNotifier({
        packageName: "@scope/my-cli",
        currentVersion: "1.0.0",
        updateCommand: "my-cli update && echo '<done>'",
      }),
    ]);

    await app.run(["ok", "--json"]);

    expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { value: 42 } });
    expect(stderr).toContain('<system-message type="update-available">');
    expect(stderr).toContain("<latest-version>2.0.0</latest-version>");
    expect(stderr).toContain("my-cli update &amp;&amp; echo &apos;&lt;done&gt;&apos;");

    stderr = "";
    await app.run(["ok", "--json"]);
    expect(stderr).toBe("");

    seedCache("@scope/my-cli", {
      latest: "2.1.0",
      checkedAt: Date.now(),
      notifiedAt: Date.now(),
      notifiedVersion: "2.0.0",
    });
    await app.run(["ok", "--json"]);
    expect(stderr).toContain("<latest-version>2.1.0</latest-version>");
  });

  it("never appends a notice to a structured command error", async () => {
    seedCache("my-cli", { latest: "9.0.0", checkedAt: Date.now() });
    const app = await createApp([
      createUpdateNotifier({
        packageName: "my-cli",
        currentVersion: "1.0.0",
      }),
    ]);

    await app.run(["fail", "--json"]);

    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      ok: false,
      error: { type: "api", subtype: "not_found" },
    });
    expect(stderr).not.toContain("system-message");
  });

  it("uses semantic-version precedence for prereleases", async () => {
    seedCache("my-cli", { latest: "1.0.0-beta.2", checkedAt: Date.now() });
    const app = await createApp([
      createUpdateNotifier({
        packageName: "my-cli",
        currentVersion: "1.0.0-beta.1",
      }),
    ]);

    await app.run(["ok", "--json"]);
    expect(stderr).toContain("<latest-version>1.0.0-beta.2</latest-version>");

    stdout = "";
    stderr = "";
    seedCache("stable-cli", { latest: "1.0.0-beta.1", checkedAt: Date.now() });
    const stableApp = await createApp(
      [
        createUpdateNotifier({
          packageName: "stable-cli",
          currentVersion: "1.0.0",
        }),
      ],
      "stable-cli",
    );
    await stableApp.run(["ok", "--json"]);
    expect(stderr).toBe("");
  });

  it("supports the standard environment kill switch", async () => {
    seedCache("my-cli", { latest: "9.0.0", checkedAt: Date.now() });
    process.env.NO_UPDATE_NOTIFIER = "1";
    const app = await createApp([
      createUpdateNotifier({
        packageName: "my-cli",
        currentVersion: "1.0.0",
      }),
    ]);

    await app.run(["ok", "--json"]);

    expect(JSON.parse(stdout).ok).toBe(true);
    expect(stderr).toBe("");
  });

  it("refreshes a stale cache in a detached helper for a later invocation", async () => {
    registry = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ "dist-tags": { latest: "3.0.0" } }));
    });
    await new Promise<void>((resolve) => registry!.listen(0, "127.0.0.1", resolve));
    const address = registry.address();
    if (!address || typeof address === "string") throw new Error("registry did not start");
    const options = {
      packageName: "refresh-cli",
      currentVersion: "1.0.0",
      registryUrl: `http://127.0.0.1:${address.port}`,
      checkIntervalMs: 0,
      retryIntervalMs: 0,
      timeoutMs: 1_000,
    };
    const app = await createApp([createUpdateNotifier(options)]);

    await app.run(["ok", "--json"]);
    expect(stderr).toBe("");
    await vi.waitFor(
      () => {
        const cache = JSON.parse(readCacheFile("refresh-cli"));
        expect(cache.latest).toBe("3.0.0");
      },
      { timeout: 3_000 },
    );

    stdout = "";
    stderr = "";
    const nextApp = await createApp([createUpdateNotifier(options)]);
    await nextApp.run(["ok", "--json"]);
    expect(JSON.parse(stdout).ok).toBe(true);
    expect(stderr).toContain("<latest-version>3.0.0</latest-version>");
  });

  it("isolates a failing app-level observer from output and exit status", async () => {
    const broken: Plugin = {
      name: "broken-after-run",
      async afterAppRun() {
        throw new Error("observer failed");
      },
    };
    const app = await createApp([broken]);

    await app.run(["ok", "--json"]);

    expect(JSON.parse(stdout).data).toEqual({ value: 42 });
    expect(stderr).toBe("");
    expect(process.exitCode).toBe(0);
  });

  it("runs afterAppRun once per run, including when an error handler recovers", async () => {
    let calls = 0;
    const recover: Plugin = {
      name: "recover-and-observe",
      async handleError() {
        return { action: "recover", result: { data: { recovered: true } } };
      },
      async afterAppRun(event) {
        expect(event.exitCode).toBe(0);
        calls += 1;
      },
    };
    const app = await createApp([recover]);

    await app.run(["fail", "--json"]);
    stdout = "";
    await app.run(["ok", "--json"]);

    expect(JSON.parse(stdout).data).toEqual({ value: 42 });
    expect(stderr).toBe("");
    expect(calls).toBe(2);
    expect(process.exitCode).toBe(0);
  });

  it("passes the failed run's exit code to afterAppRun observers", async () => {
    const codes: number[] = [];
    const observer: Plugin = {
      name: "exit-observer",
      async afterAppRun(event) {
        codes.push(event.exitCode);
      },
    };
    const app = await createApp([observer]);

    await app.run(["fail", "--json"]);

    expect(codes).toEqual([1]);
  });

  it("rejects registry URLs that could leak credentials to a detached process", () => {
    expect(() =>
      createUpdateNotifier({
        packageName: "my-cli",
        currentVersion: "1.0.0",
        registryUrl: "https://user:secret@registry.example.test",
      }),
    ).toThrow("registryUrl must not contain credentials");
  });
});

async function createApp(plugins: Plugin[], name = "my-cli") {
  return defineCliApp({
    name,
    description: "test",
    localState,
    plugins,
    commands: {
      ok: defineCommand({
        name: "ok",
        description: "succeed",
        async run() {
          return { data: { value: 42 } };
        },
      }),
      fail: defineCommand({
        name: "fail",
        description: "fail",
        async run() {
          throw new errs.NotFoundError("not found");
        },
      }),
    },
  });
}

function seedCache(
  packageName: string,
  value: {
    latest: string;
    checkedAt: number;
    notifiedAt?: number;
    notifiedVersion?: string;
  },
): void {
  const key = createHash("sha256").update(packageName).digest("hex").slice(0, 24);
  const directory = localState.paths.updatesDir;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${key}.json`), JSON.stringify({ packageName, ...value }));
}

function readCacheFile(packageName: string): string {
  const key = createHash("sha256").update(packageName).digest("hex").slice(0, 24);
  return readFileSync(join(localState.paths.updatesDir, `${key}.json`), "utf8");
}
