#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDir = mkdtempSync(join(tmpdir(), "cli-kit-package-"));
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
    "package/docs/09-production-contracts.md",
    "package/docs/09-production-contracts.en.md",
    "package/dist/advanced.js",
    "package/dist/advanced.d.ts",
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
      'import { defineCliApp, defineCommand, defineAuth, createMemoryLocalState, errs } from "@myriosx/cli-kit";',
      'import * as errorExports from "@myriosx/cli-kit/errs";',
      'import * as credentialExports from "@myriosx/cli-kit/credentials";',
      'import * as skillExports from "@myriosx/cli-kit/skills";',
      'import * as z from "zod";',
      'import * as sdk from "@myriosx/cli-kit";',
      'import * as advanced from "@myriosx/cli-kit/advanced";',
      "for (const removed of ['applyPlugins', 'createOn401Hook', 'resolveIdentityWithChain']) if (removed in sdk) throw new Error('removed API exported: ' + removed);",
      "for (const moved of ['runCommand', 'setupPlugins', 'createContext', 'createFetchAdapter', 'generateAutogenBlock']) if (moved in sdk) throw new Error('advanced API leaked into root: ' + moved);",
      "if (!advanced.runCommand || !advanced.setupPlugins || !advanced.createContext || !advanced.createFetchAdapter) throw new Error('advanced subpath failed');",
      "if (!defineCliApp || !defineCommand || !errs) throw new Error('root export failed');",
      "if (!errorExports.errs) throw new Error('errs subpath failed');",
      "if (!credentialExports.memoryStore) throw new Error('credentials subpath failed');",
      "if (!skillExports.listSkills) throw new Error('skills subpath failed');",
      "const command = defineCommand({ name: 'create', description: 'create', args: { type: 'json', schema: z.object({ id: z.string() }) }, async run(_ctx, args) { return { data: args }; } });",
      "globalThis.fetch = async () => new Response(JSON.stringify({message:'upstream unavailable'}), {status:500});",
      "const fail = defineCommand({ name:'fail', description:'HTTP failure', async run(ctx) { return {data:(await ctx.get('/items')).data}; } });",
      "const cancel = defineCommand({ name:'cancel', description:'caller cancellation', async run(ctx) { return {data:(await ctx.get('/items', undefined, {signal:AbortSignal.abort()})).data}; } });",
      "const app = await defineCliApp({ name: 'smoke', binName: 'smoke', description: 'smoke', baseUrl:'https://smoke.invalid', requestTimeoutMs:500, localState: createMemoryLocalState(), plugins: [defineAuth({ credentialNamespace: 'smoke', baseUrl: 'https://smoke.invalid', bearerToken: 'fixture' })], commands: { create: command, fail, cancel } });",
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

  for (const [command, status, subtype] of [
    ["fail", 1, "server_error"],
    ["cancel", 4, "cancelled"],
  ]) {
    let failure;
    try {
      run(process.execPath, ["smoke.mjs", command, "--json"], consumerDir);
    } catch (error) {
      failure = error;
    }
    assert(failure?.status === status, `published ${command} exit code failed`);
    assert(String(failure.stdout).trim() === "", `published ${command} polluted stdout`);
    const envelope = JSON.parse(String(failure.stderr));
    assert(
      envelope.ok === false && envelope.error.subtype === subtype,
      `published ${command} error contract failed`,
    );
  }

  writeFileSync(
    join(consumerDir, "types.mts"),
    [
      'import { defineCli, type CommandContext, type RequestControls } from "@myriosx/cli-kit";',
      'import { createContext, setupPlugins } from "@myriosx/cli-kit/advanced";',
      'import { generateAutogenBlock } from "@myriosx/cli-kit/skills";',
      "declare const ctx: CommandContext;",
      "const controls: RequestControls = { timeout: 100, signal: new AbortController().signal };",
      'void ctx.get<{id:string}>("/items", undefined, controls);',
      'void ctx.delete("/items/1", controls);',
      'defineCli({name:"types",description:"fixture",commands:{},requestTimeoutMs:100});',
      "// @ts-expect-error Runtime dispatchers are not part of the root API.",
      'import { runCommand } from "@myriosx/cli-kit";',
      "void [createContext,setupPlugins,generateAutogenBlock,runCommand];",
    ].join("\n"),
  );
  run(
    node,
    [
      join(packageDir, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2024",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--typeRoots",
      join(packageDir, "node_modules", "@types"),
      "types.mts",
    ],
    consumerDir,
  );

  console.log(`Package smoke test passed: ${tarballName}`);
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
