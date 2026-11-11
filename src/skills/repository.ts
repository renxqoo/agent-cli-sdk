import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { DefineCliOptions } from "../types.js";
import { APIError, InternalError } from "../errs/index.js";
import { generateSkillSkeleton, refreshAutogen, type GenLang } from "./gen.js";
import {
  listPath,
  listSkills,
  prepareSkillDir,
  readReference,
  readSkill,
  splitArg,
  type DirEntry,
  type SkillInfo,
} from "./reader.js";
import { syncSkills, type SyncResult } from "./sync.js";
import type { SkillTarget } from "./targets.js";
import { assertExistingPathInside } from "./path-guard.js";
import { withFileLockSync } from "../infra/file-lock.js";
import { writeAtomicFile } from "../infra/atomic-file.js";

export interface SkillRepositoryOptions {
  root: string;
  binName: string;
  cli: Pick<DefineCliOptions<any>, "commands" | "namespaces" | "name" | "binName">;
  targets?: SkillTarget[];
}

export interface GenerateSkillOptions {
  name: string;
  initialize?: boolean;
  force?: boolean;
  language?: GenLang;
}

/** Cohesive skill collection: discovery, content, generation and publication. */
export class SkillRepository {
  readonly #options: SkillRepositoryOptions;

  constructor(options: SkillRepositoryOptions) {
    this.#options = options;
  }

  list(): SkillInfo[] {
    return listSkills(this.#options.root);
  }

  listAt(path: string): { entries: DirEntry[]; listed: string } {
    return listPath(this.#options.root, path);
  }

  read(path: string): string {
    const [name, reference] = splitArg(path);
    return reference
      ? readReference(this.#options.root, name, reference).content.toString("utf8")
      : readSkill(this.#options.root, name).toString("utf8");
  }

  sync(): SyncResult {
    return syncSkills(
      this.#options.root,
      this.#options.targets ? { targets: this.#options.targets } : undefined,
    );
  }

  generate(options: GenerateSkillOptions): { path: string; mode: "init" | "refresh" } {
    const directory = prepareSkillDir(this.#options.root, options.name);
    const path = join(directory, "SKILL.md");
    return withFileLockSync(this.#options.root, `generate-${options.name}`, () => {
      const exists = existsSync(path);
      let entry;
      try {
        entry = lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (entry) {
        const resolved = assertExistingPathInside(directory, path, "Generated skill file");
        if (!lstatSync(resolved).isFile())
          throw new InternalError({
            subtype: "contract_violation",
            message: "SKILL.md must be a regular file",
          });
      }
      const language = options.language ?? "en";

      if (options.initialize && exists && !options.force) {
        throw new APIError({
          subtype: "already_exists",
          message: `${path} already exists. Use --force to overwrite with the skeleton, or drop --init to refresh the AUTO-GEN block in place.`,
          hint: "gen <name> --init --force  (overwrite)   |   gen <name>  (refresh in place)",
        });
      }

      if (options.initialize || !exists) {
        writeAtomicFile(
          path,
          generateSkillSkeleton(
            options.name,
            `${this.#options.binName} business skill`,
            this.#options.binName,
            this.#options.cli,
            language,
          ),
        );
        return { path, mode: "init" };
      }

      writeAtomicFile(
        path,
        refreshAutogen(
          readSkill(this.#options.root, options.name).toString("utf8"),
          this.#options.binName,
          this.#options.cli,
          language,
        ),
      );
      return { path, mode: "refresh" };
    });
  }
}
