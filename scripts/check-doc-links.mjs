#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [
  join(packageDir, "README.md"),
  join(packageDir, "README.zh-CN.md"),
  join(packageDir, "docs"),
  join(packageDir, "skills"),
  join(packageDir, "agent-cli-builder-zh-CN"),
];

function markdownFiles(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return markdownFiles(child);
    return entry.isFile() && entry.name.endsWith(".md") ? [child] : [];
  });
}

const failures = [];
for (const file of roots.flatMap(markdownFiles)) {
  const content = readFileSync(file, "utf8");
  const links = content.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const rawTarget = match[1]?.trim().replace(/^<|>$/g, "");
    if (!rawTarget || /^(?:https?:|mailto:|#)/.test(rawTarget)) continue;
    const target = decodeURIComponent(rawTarget.split("#", 1)[0] ?? "");
    if (!target) continue;
    const absoluteTarget = resolve(dirname(file), target);
    if (!existsSync(absoluteTarget)) {
      const line = content.slice(0, match.index).split("\n").length;
      failures.push(`${file}:${line} -> ${rawTarget}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Broken local Markdown links:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log("cli-sdk Markdown links are valid");
