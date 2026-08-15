import type * as z from "zod";
import type { CommandResult, Meta } from "./output-contracts.js";
import type { CommandContext } from "./runtime-contracts.js";

/** A command with no `args` declaration receives one stable, empty object. */
export type NoArgs = Record<string, never>;

type ObjectSchema = z.ZodObject;
type StringKeyOf<Schema extends ObjectSchema> = Extract<keyof z.input<Schema>, string>;

/** Native argv mode. `type` is optional because argv is the default. */
export interface ArgvArgs<Schema extends ObjectSchema = ObjectSchema> {
  type?: "argv";
  schema: Schema;
  /** Schema fields consumed as positional operands, in declaration order. */
  pos?: readonly StringKeyOf<Schema>[];
}

/** Whole-document JSON mode. JSON and business flags are intentionally not mergeable. */
export interface JsonArgs<Schema extends ObjectSchema = ObjectSchema> {
  type: "json";
  schema: Schema;
  pos?: never;
}

export type CommandArgs<Schema extends ObjectSchema = ObjectSchema> =
  | ArgvArgs<Schema>
  | JsonArgs<Schema>;

/** Optional root metadata registered on the Zod schema. It does not affect validation. */
export interface CommandSchemaMetadata {
  examples?: readonly unknown[];
  /** JSON Pointer paths redacted from audit and dry-run output. */
  sensitive?: readonly `/${string}`[];
}

export interface WritePolicy<Args = unknown, State = unknown> {
  mode: "write";
  dryRun?:
    | true
    | {
        preview?: (
          args: Args,
          context: CommandContext<State>,
        ) => Promise<CommandResult> | CommandResult;
      };
  confirmation?: "required" | "none";
  idempotency?: "required" | "optional";
  idempotencyHeader?: string;
}

export type CommandPolicy<Args = unknown, State = unknown> =
  | { mode: "read" }
  | WritePolicy<Args, State>;

export interface CommandSpec<Args = NoArgs, Result = unknown, State = unknown> {
  name: string;
  description: string;
  args?: CommandArgs;
  policy?: CommandPolicy<Args, State>;
  /**
   * C6: skip plugin `beforeCommand` hooks for this command (e.g. so a management
   * command bypasses "must be logged in"). The command stays routable and visible in
   * help — to hide a command, do not register it.
   */
  skipPluginHooks?: boolean;
  humanFormat?: (data: unknown, meta?: Meta) => string;
  run: (context: CommandContext<State>, args: Args) => Promise<CommandResult<Result> | void>;
}

export type CommandGroup<State = unknown> = Record<string, CommandSpec<any, unknown, State>>;
