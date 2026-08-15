#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = packageDir;
const temporaryDir = mkdtempSync(join(tmpdir(), "agent-cli-sdk-package-"));
const subprocessEnv = { ...process.env, npm_config_cache: join(temporaryDir, "npm-cache") };

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
  run("pnpm", ["run", "build"]);
  const packedOutput = run("npm", ["pack", "--ignore-scripts", "--pack-destination", temporaryDir]);
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

  assert(
    readFileSync(join(packageDir, "LICENSE"), "utf8") ===
      readFileSync(join(repositoryRoot, "LICENSE"), "utf8"),
    "LICENSE must stay identical to the repository LICENSE",
  );

  const consumerDir = join(temporaryDir, "consumer");
  const consumerModules = join(consumerDir, "node_modules");
  const installedPackage = join(consumerModules, "@renxqoo", "agent-cli-sdk");
  mkdirSync(installedPackage, { recursive: true });
  run("tar", ["-xzf", tarballPath, "-C", installedPackage, "--strip-components=1"]);
  for (const dependency of ["qrcode", "yaml", "zod"]) {
    symlinkSync(
      join(packageDir, "node_modules", dependency),
      join(consumerModules, dependency),
      "dir",
    );
  }
  mkdirSync(join(consumerModules, "@clack"), { recursive: true });
  symlinkSync(
    join(packageDir, "node_modules", "@clack", "prompts"),
    join(consumerModules, "@clack", "prompts"),
    "dir",
  );
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2),
  );
  writeFileSync(
    join(consumerDir, "smoke.mjs"),
    [
      'import { defineCli, defineCommand, errs } from "@renxqoo/agent-cli-sdk";',
      'import * as errorExports from "@renxqoo/agent-cli-sdk/errs";',
      'import * as credentialExports from "@renxqoo/agent-cli-sdk/credentials";',
      'import * as skillExports from "@renxqoo/agent-cli-sdk/skills";',
      'import * as z from "zod";',
      "if (!defineCli || !defineCommand || !errs) throw new Error('root export failed');",
      "if (!errorExports.errs) throw new Error('errs subpath failed');",
      "if (!credentialExports.memoryStore) throw new Error('credentials subpath failed');",
      "if (!skillExports.listSkills) throw new Error('skills subpath failed');",
      "const command = defineCommand({ name: 'create', description: 'create', args: { type: 'json', schema: z.object({ id: z.string() }) }, async run(_ctx, args) { return { data: args }; } });",
      "if (command.args?.type !== 'json') throw new Error('direct Zod args failed');",
    ].join("\n"),
  );
  run("node", ["smoke.mjs"], consumerDir);

  console.log(`Package smoke test passed: ${tarballName}`);
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
