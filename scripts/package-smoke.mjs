#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDir = mkdtempSync(join(tmpdir(), "agent-cli-sdk-package-"));
const subprocessEnv = {
  ...process.env,
  npm_config_cache: join(temporaryDir, "npm-cache"),
  BUN_INSTALL_CACHE_DIR: join(temporaryDir, "bun-cache"),
};

function run(command, args, cwd = packageDir) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: subprocessEnv,
  }).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const node = run("node", ["-p", "process.execPath"]);
  const npmCli = [
    join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find(existsSync);
  assert(npmCli, "Node distribution must include npm");
  const buildManifest = JSON.parse(
    readFileSync(join(packageDir, "node_modules", "tsup", "package.json"), "utf8"),
  );
  run(node, [join(packageDir, "node_modules", "tsup", buildManifest.bin.tsup)]);

  const packedOutput = run(node, [
    npmCli,
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    temporaryDir,
  ]);
  const tarballName = packedOutput.split(/\r?\n/).at(-1);
  assert(tarballName, "pnpm pack did not return a tarball name");

  const tarballPath = isAbsolute(tarballName) ? tarballName : join(temporaryDir, tarballName);
  const entries = new Set(run("tar", ["-tzf", tarballPath]).split(/\r?\n/));
  const requiredEntries = [
    "package/LICENSE",
    "package/README.md",
    "package/README.zh-CN.md",
    "package/docs/00-overview.md",
    "package/docs/01-cli-usage.md",
    "package/docs/02-sdk-guide.md",
    "package/docs/03-envelopes.md",
    "package/docs/04-errors.md",
    "package/docs/05-credentials.md",
    "package/docs/06-skills.md",
    "package/docs/07-structured-input.md",
    "package/docs/08-runtime-refactor.md",
  ];

  for (const entry of requiredEntries) {
    assert(entries.has(entry), `published package is missing ${entry}`);
  }
  for (const entry of entries) {
    assert(
      !entry.includes("/__tests__/") && !entry.endsWith(".test.ts"),
      `published package must not contain test source: ${entry}`,
    );
    assert(
      !entry.startsWith("package/src/"),
      `published package must not contain source: ${entry}`,
    );
  }

  const consumerDir = join(temporaryDir, "consumer");
  mkdirSync(consumerDir);
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  if (process.versions.bun) {
    run(process.execPath, ["add", "--ignore-scripts", tarballPath], consumerDir);
  } else {
    run(
      node,
      [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
      consumerDir,
    );
  }
  writeFileSync(
    join(consumerDir, "smoke.mjs"),
    [
      'import { defineCliApp, defineCommand, defineAuth, createMemoryLocalState, errs } from "@renxqoo/agent-cli-sdk";',
      'import * as errorExports from "@renxqoo/agent-cli-sdk/errs";',
      'import * as credentialExports from "@renxqoo/agent-cli-sdk/credentials";',
      'import * as skillExports from "@renxqoo/agent-cli-sdk/skills";',
      'import * as z from "zod";',
      'import * as sdk from "@renxqoo/agent-cli-sdk";',
      "for (const removed of ['applyPlugins', 'createOn401Hook', 'resolveIdentityWithChain']) if (removed in sdk) throw new Error('removed API exported: ' + removed);",
      "if (!defineCliApp || !defineCommand || !errs) throw new Error('root export failed');",
      "if (!errorExports.errs) throw new Error('errs subpath failed');",
      "if (!credentialExports.memoryStore) throw new Error('credentials subpath failed');",
      "if (!skillExports.listSkills) throw new Error('skills subpath failed');",
      "const command = defineCommand({ name: 'create', description: 'create', args: { type: 'json', schema: z.object({ id: z.string() }) }, async run(_ctx, args) { return { data: args }; } });",
      "const app = await defineCliApp({ name: 'smoke', binName: 'smoke', description: 'smoke', localState: createMemoryLocalState(), plugins: [defineAuth({ credentialNamespace: 'smoke', baseUrl: 'https://smoke.invalid', bearerToken: 'fixture' })], commands: { create: command } });",
      "await app.run(process.argv.slice(2));",
    ].join("\n"),
  );
  const output = run(
    process.execPath,
    ["smoke.mjs", "create", "--input", '{"id":"record-1"}'],
    consumerDir,
  );
  const result = JSON.parse(output);
  assert(result.ok === true && result.data.id === "record-1", "published command runtime failed");
  const help = run(process.execPath, ["smoke.mjs", "--help"], consumerDir);
  assert(help.includes("Usage:") && help.includes("create"), "published help failed");

  console.log(`Package smoke test passed: ${tarballName}`);
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
