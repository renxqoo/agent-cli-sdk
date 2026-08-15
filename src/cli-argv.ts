import type { CommandSpec } from "./types.js";
import type { CompiledCommandSchema } from "./command-schema.js";
export { RESERVED_FRAMEWORK_ARGS } from "./command-registry.js";

export const MISSING_FLAG_VALUE = Symbol("missing-flag-value");

export interface FrameworkArgs {
  commandArgv: string[];
  format?: "json" | "human";
  apiKey?: unknown;
  leadingHelp: boolean;
  leadingVersion: boolean;
}

export interface RoutedCommand<State = unknown> {
  route: string[];
  spec: CommandSpec<any, unknown, State>;
  schema: CompiledCommandSchema;
  /** Framework-provided default command — grouped separately in top-level help. */
  framework?: boolean;
}

export interface MatchResult<State = unknown> {
  matched: RoutedCommand<State> | null;
  rest: string[];
}

/**
 * 提取框架保留参数，同时保留命令参数的相对顺序。
 *
 * `--json` / `--no-json` / `--api-key` 可放在命令路径前后；`--` 后不再解释。
 * help/version 只有位于首个命令 token 前才是顶层动作，命令后的 help 由命令帮助处理，
 * 命令后的 version 作为未知命令参数报错。
 */
export function parseFrameworkArgs(argv: string[]): FrameworkArgs {
  const commandArgv: string[] = [];
  let format: "json" | "human" | undefined;
  let apiKey: unknown;
  let leadingHelp = false;
  let leadingVersion = false;
  let commandStarted = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      commandArgv.push(...argv.slice(i));
      break;
    }
    if (token === "--json") {
      format = "json";
      continue;
    }
    if (token === "--no-json") {
      format = "human";
      continue;
    }
    if (token.startsWith("--api-key=")) {
      apiKey = token.slice("--api-key=".length);
      continue;
    }
    if (token === "--api-key") {
      const next = argv[i + 1];
      if (next === undefined || next === "--" || isFrameworkFlag(next)) {
        apiKey = MISSING_FLAG_VALUE;
      } else {
        apiKey = next;
        i++;
      }
      continue;
    }
    if (!commandStarted && (token === "--help" || token === "-h")) {
      leadingHelp = true;
      continue;
    }
    if (!commandStarted && (token === "--version" || token === "-v")) {
      leadingVersion = true;
      continue;
    }

    commandArgv.push(token);
    if (!token.startsWith("-")) commandStarted = true;
  }

  return { commandArgv, format, apiKey, leadingHelp, leadingVersion };
}

/** 命令路径必须是去掉框架参数后的 argv 前缀；优先匹配最长路径。 */
export function matchRoute<State>(
  argv: string[],
  routed: RoutedCommand<State>[],
): MatchResult<State> {
  const sorted = [...routed].sort((a, b) => b.route.length - a.route.length);
  for (const candidate of sorted) {
    if (
      argv.length >= candidate.route.length &&
      candidate.route.every((segment, index) => argv[index] === segment)
    ) {
      return { matched: candidate, rest: argv.slice(candidate.route.length) };
    }
  }
  return { matched: null, rest: argv };
}

export function hasCommandHelp(argv: string[]): boolean {
  const separator = argv.indexOf("--");
  const searchable = separator < 0 ? argv : argv.slice(0, separator);
  return searchable.some((arg) => arg === "-h" || arg === "--help");
}

function isFrameworkFlag(token: string): boolean {
  return (
    token === "--json" ||
    token === "--no-json" ||
    token === "--api-key" ||
    token.startsWith("--api-key=") ||
    token === "--help" ||
    token === "-h" ||
    token === "--version" ||
    token === "-v"
  );
}
