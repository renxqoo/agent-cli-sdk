import { createHash } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { InternalError } from "../errs/index.js";
import { createPathGuard } from "./path-guard.js";

export interface SkillTree {
  directories: string[];
  files: { path: string; content: Buffer; mode: number }[];
  digest: string;
}

/** Read a complete validated source once, so every target receives identical bytes. */
export function readSkillTree(root: string, allowedRoot = root): SkillTree {
  const resolveInside = createPathGuard(allowedRoot);
  const files: SkillTree["files"] = [];
  const directories: SkillTree["directories"] = [];
  const ancestors = new Set<string>();
  const hash = createHash("sha256");
  const visit = (path: string, subpath: string): void => {
    const info = lstatSync(path);
    let resolved: string;
    try {
      resolved = resolveInside(path, "Skill content");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && info.isSymbolicLink()) return;
      throw error;
    }
    const actual = lstatSync(resolved);
    if (actual.isDirectory()) {
      if (ancestors.has(resolved)) return;
      ancestors.add(resolved);
      if (subpath) directories.push(subpath);
      hash.update(JSON.stringify(["directory", subpath]));
      for (const entry of readdirSync(resolved).toSorted()) {
        visit(join(resolved, entry), subpath ? `${subpath}/${entry}` : entry);
      }
      ancestors.delete(resolved);
      return;
    }
    if (!actual.isFile())
      throw new InternalError({
        subtype: "contract_violation",
        message: "Skill content must contain only regular files and directories",
      });
    const fd = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.ino !== actual.ino || opened.dev !== actual.dev) {
        throw new InternalError({
          subtype: "contract_violation",
          message: "Skill content changed while being read",
        });
      }
      const content = readFileSync(fd);
      const mode = opened.mode & 0o777;
      hash.update(JSON.stringify(["file", subpath, content.length, mode]));
      hash.update(content);
      files.push({ path: subpath, content, mode });
    } finally {
      closeSync(fd);
    }
  };
  visit(root, "");
  if (!lstatSync(realpathSync(root)).isDirectory())
    throw new InternalError({
      subtype: "contract_violation",
      message: "Skill root must be a directory",
    });
  return { files, directories, digest: hash.digest("hex") };
}

export function writeSkillTree(tree: SkillTree, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const directory of tree.directories)
    mkdirSync(join(destination, directory), { recursive: true });
  for (const file of tree.files) {
    const path = join(destination, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content, { flag: "wx", mode: file.mode });
    chmodSync(path, file.mode);
  }
}
