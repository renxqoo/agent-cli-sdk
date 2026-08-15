/**
 * Node/terminal adapter for the installation workflow.
 *
 * Internal module consumed by `defineInstaller` (src/installer.ts). Not part of the
 * public API: the install wizard is a plugin-provided command, not a standalone function.
 * All wizard UI is written to stderr — stdout stays reserved for the data contract.
 */
import { execFile, execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type InstallLanguage,
  type InstallPresenter,
  type InstallSystem,
} from "./install-workflow.js";
import type { FileLocalState } from "./local-state.js";

type Clack = typeof import("@clack/prompts");
const isWindows = process.platform === "win32";

function execCommand(command: string, args: string[], options?: ExecFileSyncOptions): Buffer {
  return execFileSync(
    isWindows ? "cmd.exe" : command,
    isWindows ? ["/c", command, ...args] : args,
    options,
  ) as Buffer;
}

function runAsync(
  command: string,
  args: string[],
  options: ExecFileSyncOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      isWindows ? "cmd.exe" : command,
      isWindows ? ["/c", command, ...args] : args,
      { stdio: ["ignore", "pipe", "pipe"], ...options },
      (error, stdout) => (error ? reject(error) : resolve(stdout as Buffer)),
    );
  });
}

function findGlobalBinary(binName: string): string | null {
  try {
    const prefix = execCommand("npm", ["prefix", "-g"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    const candidate = isWindows ? join(prefix, `${binName}.cmd`) : join(prefix, "bin", binName);
    if (existsSync(candidate)) return candidate;
  } catch {
    // Fall through to the shell path lookup.
  }
  try {
    return execCommand(isWindows ? "where" : "which", [binName], {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .split("\n")[0]!
      .trim();
  } catch {
    return null;
  }
}

export class NodeInstallSystem implements InstallSystem {
  constructor(private readonly localState: FileLocalState) {}

  async globallyInstalledVersion(packageName: string): Promise<string | null> {
    try {
      const output = execCommand("npm", ["list", "-g", packageName], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      }).toString();
      return output.match(/@(\d+\.\d+\.\d+[^\s]*)/)?.[1] ?? "unknown";
    } catch {
      return null;
    }
  }

  async latestVersion(packageName: string): Promise<string | null> {
    try {
      const version = execCommand("npm", ["view", packageName, "version"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      })
        .toString()
        .trim();
      return /^\d+\.\d+\.\d+/.test(version) ? version : null;
    } catch {
      return null;
    }
  }

  async installGlobally(packageName: string): Promise<void> {
    await runAsync("npm", ["install", "-g", packageName], { timeout: 120_000 });
  }

  async installSkillsFrom(source: string): Promise<void> {
    await runAsync("npx", ["-y", "skills", "add", source, "-y", "-g"], { timeout: 120_000 });
  }

  async findBinary(binName: string): Promise<string | null> {
    return findGlobalBinary(binName);
  }

  async syncSkills(binary: string): Promise<void> {
    await runAsync(binary, ["skills", "sync"], { timeout: 60_000 });
  }

  /**
   * "Registered" means any namespace under config/ holds a clientId — config is
   * namespace-partitioned, and the installer cannot know the app's auth namespace.
   */
  async isRegistered(): Promise<boolean> {
    try {
      const dir = this.localState.paths.configDir;
      if (!existsSync(dir)) return false;
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".json")) continue;
        const namespace = entry.slice(0, -".json".length);
        const config = (await this.localState.store.loadConfig(namespace)) as {
          clientId?: string;
        };
        if (config.clientId) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async register(binary: string): Promise<void> {
    // M15: honor the async InstallSystem contract (was a blocking execFileSync).
    await runAsync(binary, ["auth", "register"], { stdio: "inherit" });
  }

  async login(binary: string): Promise<void> {
    await runAsync(binary, ["auth", "login"], { stdio: "inherit" });
  }
}

export class ClackInstallPresenter implements InstallPresenter {
  private spinner?: ReturnType<Clack["spinner"]>;

  constructor(
    private readonly clack: Clack,
    private readonly interactive: boolean,
  ) {}

  async chooseLanguage(): Promise<InstallLanguage | null> {
    const value = await this.clack.select({
      message: "Select language / 请选择语言",
      options: [
        { value: "en" as const, label: "English" },
        { value: "zh" as const, label: "中文" },
      ],
    });
    return this.clack.isCancel(value) ? null : (value as InstallLanguage);
  }

  async confirmLogin(message: string): Promise<boolean | null> {
    const value = await this.clack.confirm({ message });
    return this.clack.isCancel(value) ? null : value;
  }

  intro(message: string): void {
    // Wizard UI never touches stdout: the install command keeps the data channel clean.
    if (this.interactive) this.clack.intro(message);
    else console.error(message);
  }

  outro(message: string): void {
    this.clack.outro(message);
  }

  start(message: string): void {
    if (!this.interactive) return;
    this.spinner = this.clack.spinner();
    this.spinner.start(message);
  }

  update(message: string): void {
    this.spinner?.message(message);
  }

  succeed(message: string): void {
    if (this.interactive) this.spinner?.stop(message);
  }

  fail(message: string): void {
    if (this.interactive) this.spinner?.stop(message);
  }

  info(message: string): void {
    if (this.interactive) this.clack.log.info(message);
    else console.error(message);
  }

  warn(message: string): void {
    this.clack.log.warn(message);
  }

  cancel(message: string): void {
    this.clack.cancel(message);
  }
}
