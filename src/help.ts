/**
 * CLI 帮助文本渲染(renderHelp / renderCommandHelp)。
 *
 * 从 define.ts 抽出:输出渲染与命令定义/App 装配解耦。
 */
import type { CommandSpec } from "./types.js";
import type { CompiledCommandSchema } from "./command-schema.js";
import { detectVersion } from "./package-detect.js";

interface RoutedView<State> {
  route: string[];
  spec: CommandSpec<any, unknown, State>;
  schema: CompiledCommandSchema;
  framework?: boolean;
}

interface CommandRow {
  cmdStr: string;
  desc: string;
}

function commandRows<State>(routed: readonly RoutedView<State>[]): CommandRow[] {
  return routed.map((r) => {
    const sig = r.schema.signature;
    const pos = sig.positionals.join(" ");
    return { cmdStr: `${r.route.join(" ")}${pos ? " " + pos : ""}`, desc: r.spec.description };
  });
}

function renderCommandTable(rows: readonly CommandRow[], maxLen: number): string[] {
  return rows.map((e) => `  ${e.cmdStr.padEnd(maxLen + 2)}${e.desc}`);
}

/** 渲染顶层 help:应用命令在前(排序),框架内置命令分组在后,并补全框架 flag。 */
export function renderHelp<State>(
  binName: string,
  description: string,
  routed: readonly RoutedView<State>[],
): string {
  const lines: string[] = [];
  lines.push(`${binName}/${detectVersion()}`);
  if (description) lines.push(description);
  lines.push("");
  lines.push("Usage:");
  lines.push(`  $ ${binName} <command> [options]`);
  lines.push("");

  const app = commandRows(routed.filter((r) => !r.framework));
  const builtin = commandRows(routed.filter((r) => r.framework));

  if (app.length > 0) {
    lines.push("Commands:");
    const maxLen = Math.max(...app.map((e) => e.cmdStr.length), 0);
    lines.push(
      ...renderCommandTable(
        [...app].sort((a, b) => a.cmdStr.localeCompare(b.cmdStr)),
        maxLen,
      ),
    );
    lines.push("");
  }
  if (builtin.length > 0) {
    lines.push("Built-in commands:");
    const maxLen = Math.max(...builtin.map((e) => e.cmdStr.length), 0);
    lines.push(
      ...renderCommandTable(
        [...builtin].sort((a, b) => a.cmdStr.localeCompare(b.cmdStr)),
        maxLen,
      ),
    );
    lines.push("");
  }

  lines.push("Options:");
  lines.push("  -h, --help      Display this message");
  lines.push("  -v, --version   Display version number");
  lines.push("  --json          Emit machine-readable envelopes (default for pipes)");
  lines.push("  --no-json       Emit human-readable text");
  lines.push("  --api-key <key> Override credentials for one command");
  return lines.join("\n");
}

/** 渲染单个命令的帮助(子命令 -h 时用),含 flag 描述表。 */
export function renderCommandHelp<State>(
  binName: string,
  matched: {
    route: string[];
    spec: CommandSpec<any, unknown, State>;
    schema: CompiledCommandSchema;
  },
): string {
  const sig = matched.schema.signature;
  const pos = sig.positionals.join(" ");
  const usage =
    `${binName} ${matched.route.join(" ")}${pos ? " " + pos : ""} ${sig.options.join(" ")}`.trim();
  const lines: string[] = [];
  lines.push(`${matched.spec.description}`);
  lines.push("");
  lines.push("Usage:");
  lines.push(`  $ ${usage}`);

  // C8: render a flag/description table from descriptors (plus policy flags).
  const descRows = matched.schema.descriptors
    .filter((d) => !d.positional)
    .map((d) => ({ token: d.signature, desc: d.description ?? "—" }));
  const policyRows: { token: string; desc: string }[] = [];
  if (matched.spec.policy?.mode === "write") {
    if (matched.spec.policy.dryRun)
      policyRows.push({ token: "[--dry-run]", desc: "Preview without writing" });
    if (matched.spec.policy.confirmation === "required")
      policyRows.push({ token: "[--yes]", desc: "Skip confirmation prompt" });
    if (matched.spec.policy.idempotency)
      policyRows.push({
        token:
          matched.spec.policy.idempotency === "required"
            ? "--idempotency-key <string>"
            : "[--idempotency-key <string>]",
        desc: "Stable key for safe retries",
      });
  }
  const rows = [...descRows, ...policyRows];

  if (rows.length > 0) {
    lines.push("");
    lines.push("Options:");
    const maxLen = Math.max(...rows.map((r) => r.token.length), 0);
    for (const r of rows) lines.push(`  ${r.token.padEnd(maxLen + 2)}${r.desc}`);
  }

  if (matched.schema.mode === "json") {
    lines.push("");
    lines.push("JSON arguments:");
    lines.push("  Provide one complete JSON document with --input, --input-file, or native stdin.");
    lines.push("  JSON cannot be combined with business flags or positional operands.");
    lines.push("  Discovery: --input-schema or --input-example");
    lines.push("  Security: prefer --input-file or stdin for sensitive values.");
  }
  return lines.join("\n");
}
