import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { InternalError, NotFoundError } from "../errs/index.js";

/** Validate a skill identifier before using it as a path segment. */
export function validateSkillName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new NotFoundError(
      `unknown skill "${name}". run 'rxcli skills list' to see available skills`,
    );
  }
}

/** Resolve an existing path and prove that symlinks did not escape its allowed root. */
export function assertExistingPathInside(
  allowedRoot: string,
  candidate: string,
  label: string,
): string {
  const root = realpathSync(allowedRoot);
  const resolved = realpathSync(candidate);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new InternalError({
      subtype: "contract_violation",
      message: `${label} resolves outside its allowed directory`,
    });
  }
  return resolved;
}

/** Prepare a generated skill directory while rejecting pre-existing escaping symlinks. */
export function prepareSkillDir(skillsRoot: string, name: string): string {
  validateSkillName(name);
  mkdirSync(skillsRoot, { recursive: true });
  const candidate = join(skillsRoot, name);
  if (!existsSync(candidate)) mkdirSync(candidate);
  return assertExistingPathInside(skillsRoot, candidate, `skill "${name}"`);
}

/** Normalize an untrusted relative reference path and reject traversal. */
export function cleanSubPath(relpath: string): string {
  // A4: reject any Windows drive prefix (with or without a trailing separator) so a
  // drive-relative value like `C:etc` cannot resolve relative to another drive's CWD.
  // The realpath backstop in assertExistingPathInside still catches real escapes.
  if (!relpath || relpath.startsWith("/") || /^[a-zA-Z]:/.test(relpath)) {
    throw invalidPath(relpath);
  }
  const cleaned = normalize(relpath).split(sep).join("/");
  if (
    cleaned === "." ||
    cleaned === ".." ||
    cleaned.startsWith("../") ||
    cleaned.startsWith("..\\")
  ) {
    throw invalidPath(relpath);
  }
  return cleaned;
}

function invalidPath(relpath: string): InternalError {
  return new InternalError({
    subtype: "contract_violation",
    message: `invalid path "${relpath}": must be a relative path without '..'`,
  });
}
