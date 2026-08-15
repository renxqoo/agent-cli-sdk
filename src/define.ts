/** Public command-definition API. Application assembly lives behind one deep runtime boundary. */

import type * as z from "zod";
import type {
  App,
  CommandArgs,
  CommandGroup,
  CommandSpec,
  DefineCliOptions,
  NoArgs,
} from "./types.js";
import { createCliApplication } from "./cli-application.js";
import { validateCommandSpec } from "./command-registry.js";

type ObjectSchema = z.ZodObject;

type SchemaCommandDefinition<Schema extends ObjectSchema, Result, State> = Omit<
  CommandSpec<z.output<Schema>, Result, State>,
  "args"
> & {
  args: CommandArgs<Schema>;
};

type NoArgsCommandDefinition<Result, State> = Omit<CommandSpec<NoArgs, Result, State>, "args"> & {
  args?: undefined;
};

/** Define a command. Zod is the only argument contract and type source. */
export function defineCommand<Schema extends ObjectSchema, Result = unknown, State = unknown>(
  spec: SchemaCommandDefinition<Schema, Result, State>,
): CommandSpec<z.output<Schema>, Result, State>;

/** Define a command with no business parameters. */
export function defineCommand<Result = unknown, State = unknown>(
  spec: NoArgsCommandDefinition<Result, State>,
): CommandSpec<NoArgs, Result, State>;

export function defineCommand(
  spec: CommandSpec<any, unknown, any>,
): CommandSpec<any, unknown, any> {
  validateCommandSpec(spec.name, spec);
  return spec;
}

/** Declare a command group whose keys are the canonical command names. */
export function defineCommands<State = unknown>(group: CommandGroup<State>): CommandGroup<State> {
  for (const [key, command] of Object.entries(group)) validateCommandSpec(key, command);
  return group;
}

/** Compile a declarative CLI definition into an executable application. */
export function defineCli<State = Record<string, never>>(options: DefineCliOptions<State>): App {
  return createCliApplication(options);
}

export { detectBizPackage, type BizPackageInfo } from "./package-detect.js";
