#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const semver = new RegExp(
  `^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

function parseVersion(value) {
  const match = typeof value === "string" && semver.exec(value);
  if (!match) throw new Error(`Invalid package SemVer: ${value}`);
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") };
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const a = left.pre[i];
    const b = right.pre[i];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    if (numericA && numericB) return BigInt(a) > BigInt(b) ? 1 : -1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

/** Pure policy shared by the CLI gate and regression tests. */
export function validateRelease(current, previous, changelog) {
  const next = parseVersion(current.version);
  const before = parseVersion(previous.version);
  const renamed = current.name !== previous.name;
  if (renamed && current.version !== "0.0.1")
    throw new Error("Package renames must start at version 0.0.1");
  if (!renamed && current.version !== previous.version && compareVersions(next, before) <= 0) {
    throw new Error(
      "Package version must increase; build metadata alone is not a version increment",
    );
  }
  const heading = `## [${current.name}@${current.version}] - `;
  const entries = changelog.split(/\r?\n/).filter((line) => line.startsWith(heading));
  if (entries.length !== 1)
    throw new Error(`Expected exactly one changelog heading: ${heading}YYYY-MM-DD`);
  const date = entries[0].slice(heading.length);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  ) {
    throw new Error("Changelog release date must be a real YYYY-MM-DD date");
  }
}

function main() {
  const { values } = parseArgs({ options: { base: { type: "string", default: "HEAD" } } });
  // Resolve to a commit before constructing git's object:path expression; missing bases fail closed.
  const base = execFileSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`],
    { cwd: packageDir, encoding: "utf8" },
  ).trim();
  const previous = JSON.parse(
    execFileSync("git", ["show", `${base}:package.json`], { cwd: packageDir, encoding: "utf8" }),
  );
  const current = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  validateRelease(current, previous, readFileSync(join(packageDir, "CHANGELOG.md"), "utf8"));
  console.log(`Release metadata valid: ${current.name}@${current.version}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Release check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
