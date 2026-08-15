import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "./plugin-contracts.js";

const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RETRY_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_NOTIFICATION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

interface UpdateCache {
  packageName: string;
  latest?: string;
  checkedAt?: number;
  attemptedAt?: number;
  notifiedAt?: number;
  notifiedVersion?: string;
}

export interface UpdateNotifierOptions {
  /** Published npm package whose `latest` dist-tag should be checked. */
  packageName: string;
  /** Version bundled into the current CLI. */
  currentVersion: string;
  /** Command shown in the upgrade instruction. Defaults to `npm install -g <packageName>`. */
  updateCommand?: string;
  /** Registry base URL. Defaults to the public npm registry. */
  registryUrl?: string;
  /** Successful-check cache lifetime. Defaults to 24 hours. */
  checkIntervalMs?: number;
  /** Minimum delay between failed/background attempts. Defaults to one hour. */
  retryIntervalMs?: number;
  /** Background registry request timeout. Defaults to three seconds. */
  timeoutMs?: number;
  /** Minimum delay between repeated notices for the same cached update. Defaults to 24 hours. */
  notificationIntervalMs?: number;
  /** Explicit kill switch in addition to `NO_UPDATE_NOTIFIER=1`. */
  enabled?: boolean;
}

/**
 * Add cached update awareness without putting operational text in stdout or delaying commands on
 * registry I/O. Runs once per app run (`afterAppRun`); a stale cache is refreshed by a detached
 * helper, and failures stay silent. The cache file lives under the app's local-state updates
 * directory (file-backed local state) or in a process-local map (memory local state).
 */
export function createUpdateNotifier<State = Record<string, never>>(
  options: UpdateNotifierOptions,
): Plugin<State> {
  assertOptions(options);
  const registryUrl = resolveRegistryUrl(options.registryUrl);

  // Cache target is resolved in apply: file-backed local state gets a disk cache,
  // memory local state falls back to a process-local map (no background refresh).
  let cacheFile: string | null = null;
  const memoryCaches = new Map<string, UpdateCache>();

  const readCache = (): UpdateCache => {
    if (cacheFile) return readFileCache(cacheFile, options.packageName);
    return memoryCaches.get(options.packageName) ?? { packageName: options.packageName };
  };

  const writeCache = (cache: UpdateCache): boolean => {
    if (cacheFile) return writeFileCache(cacheFile, cache);
    memoryCaches.set(options.packageName, cache);
    return true;
  };

  return {
    name: "update-notifier",
    enforce: "post",

    apply(services) {
      if (services.localState.kind === "file") {
        cacheFile = resolveCacheFile(services.localState.paths.updatesDir, options.packageName);
      }
    },

    async afterAppRun(event) {
      // Operational notices only follow successful runs: a failed run must keep its
      // stderr error envelope parseable and free of system messages.
      if (event.exitCode !== 0) return;
      if (options.enabled === false || process.env.NO_UPDATE_NOTIFIER === "1") return;

      const now = Date.now();
      let cache = readCache();
      const notificationIntervalMs =
        options.notificationIntervalMs ?? DEFAULT_NOTIFICATION_INTERVAL_MS;
      if (
        cache.latest &&
        isNewerVersion(cache.latest, options.currentVersion) &&
        (cache.notifiedVersion !== cache.latest ||
          now - (cache.notifiedAt ?? 0) >= notificationIntervalMs)
      ) {
        process.stderr.write(renderSystemMessage(options, cache.latest));
        cache = { ...cache, notifiedAt: now, notifiedVersion: cache.latest };
        writeCache(cache);
      }

      const checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
      const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
      const lastAttempt = cache.attemptedAt ?? cache.checkedAt ?? 0;
      const successfulCheckIsFresh = now - (cache.checkedAt ?? 0) < checkIntervalMs;
      if (successfulCheckIsFresh || now - lastAttempt < retryIntervalMs) return;

      const attempted: UpdateCache = {
        ...cache,
        packageName: options.packageName,
        attemptedAt: now,
      };
      if (!writeCache(attempted)) return;
      // Detached helpers can only share a disk cache; memory local state skips the refresh.
      if (cacheFile) {
        refreshInBackground({
          cacheFile,
          packageName: options.packageName,
          registryUrl,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
      }
    },
  };
}

function resolveRegistryUrl(value?: string): string {
  try {
    const registry = new URL(value ?? "https://registry.npmjs.org");
    if (!["http:", "https:"].includes(registry.protocol)) {
      throw new TypeError("registryUrl must use http or https");
    }
    if (registry.username || registry.password) {
      throw new TypeError("registryUrl must not contain credentials");
    }
    return registry.toString();
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("registryUrl")) throw error;
    throw new TypeError(`registryUrl must be an absolute URL: ${value}`);
  }
}

function assertOptions(options: UpdateNotifierOptions): void {
  if (!options.packageName.trim()) throw new TypeError("packageName must not be empty");
  if (!parseVersion(options.currentVersion)) {
    throw new TypeError(
      `currentVersion must be a valid semantic version: ${options.currentVersion}`,
    );
  }
  for (const [name, value] of Object.entries({
    checkIntervalMs: options.checkIntervalMs,
    retryIntervalMs: options.retryIntervalMs,
    timeoutMs: options.timeoutMs,
    notificationIntervalMs: options.notificationIntervalMs,
  })) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new TypeError(`${name} must be a non-negative finite number`);
    }
  }
}

function resolveCacheFile(updatesDir: string, packageName: string): string {
  const key = createHash("sha256").update(packageName).digest("hex").slice(0, 24);
  return join(updatesDir, `${key}.json`);
}

function readFileCache(path: string, packageName: string): UpdateCache {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as UpdateCache;
    if (value.packageName !== packageName) return { packageName };
    return value;
  } catch {
    return { packageName };
  }
}

function writeFileCache(path: string, cache: UpdateCache): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(temporary, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  }
}

interface BackgroundRefreshOptions {
  cacheFile: string;
  packageName: string;
  registryUrl: string;
  timeoutMs: number;
}

function refreshInBackground(options: BackgroundRefreshOptions): void {
  try {
    const child = spawn(
      process.execPath,
      ["--eval", UPDATE_HELPER_SOURCE, JSON.stringify(options)],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.on("error", () => {});
    child.unref();
  } catch {
    // Update awareness is best-effort and must never affect command success or stderr contracts.
  }
}

const UPDATE_HELPER_SOURCE = String.raw`
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const { dirname } = require("node:path");
const helperData = JSON.parse(process.argv[1]);

(async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), helperData.timeoutMs);
  timer.unref();
  try {
    const base = helperData.registryUrl.replace(/\/$/, "");
    const url = base + "/" + encodeURIComponent(helperData.packageName);
    const response = await fetch(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: controller.signal,
    });
    if (!response.ok) return;
    const document = await response.json();
    const latest = document && document["dist-tags"] && document["dist-tags"].latest;
    if (typeof latest !== "string") return;

    let previous = {};
    try { previous = JSON.parse(await readFile(helperData.cacheFile, "utf8")); } catch {}
    const cache = {
      ...previous,
      packageName: helperData.packageName,
      latest,
      checkedAt: Date.now(),
      attemptedAt: Date.now(),
    };
    await mkdir(dirname(helperData.cacheFile), { recursive: true, mode: 0o700 });
    const temporary = helperData.cacheFile + "." + process.pid + ".tmp";
    await writeFile(temporary, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, helperData.cacheFile);
  } catch {} finally {
    clearTimeout(timer);
  }
})();
`;

function renderSystemMessage(options: UpdateNotifierOptions, latest: string): string {
  const command = options.updateCommand ?? `npm install -g ${options.packageName}`;
  return [
    '<system-message type="update-available">',
    `  <package>${escapeXml(options.packageName)}</package>`,
    `  <current-version>${escapeXml(options.currentVersion)}</current-version>`,
    `  <latest-version>${escapeXml(latest)}</latest-version>`,
    `  <action>${escapeXml(command)}</action>`,
    "  <scope>Operational notice only; it is not business output.</scope>",
    "</system-message>\n",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character]!;
  });
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function isNewerVersion(candidate: string, current: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (!left || !right) return false;
  for (let index = 0; index < left.core.length; index++) {
    if (left.core[index]! !== right.core[index]!) return left.core[index]! > right.core[index]!;
  }
  if (left.prerelease.length === 0) return right.prerelease.length > 0;
  if (right.prerelease.length === 0) return false;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return false;
    if (b === undefined) return true;
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) return Number(a) > Number(b);
    if (aNumber !== bNumber) return !aNumber;
    return a > b;
  }
  return false;
}
