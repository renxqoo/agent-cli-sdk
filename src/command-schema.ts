import type { Readable } from "node:stream";
import * as z from "zod";
import type { CommandArgs, CommandPolicy } from "./command-contracts.js";
import { InternalError, ValidationError } from "./errs/index.js";
import { resolveJson, validateZod, type JsonInputMeta } from "./json-input.js";

export const RESERVED_ARGUMENT_NAMES = new Set([
  "json",
  "no-json",
  "api-key",
  "help",
  "version",
  "input",
  "input-file",
  "input-schema",
  "input-example",
  "dry-run",
  "yes",
  "idempotency-key",
]);

const ARGUMENT_IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

type CommandArgsMode = "argv" | "json";
type ArgumentType = "string" | "number" | "boolean" | "array";

export interface ArgumentDescriptor {
  /** Zod object property name passed to `run`. */
  name: string;
  /** Kebab-case CLI flag name. */
  flagName: string;
  type: ArgumentType;
  required: boolean;
  positional: boolean;
  defaultValue?: unknown;
  description?: string;
  displayName: string;
  signature: string;
}

interface CommandSignature {
  positionals: string[];
  options: string[];
}

interface ParsedCommandTokens {
  options: Record<string, unknown>;
  positionals: string[];
}

interface CommandExecutionState {
  dryRun: boolean;
  confirmed: boolean;
  idempotencyKey?: string;
  json?: JsonInputMeta;
}

export const commandExecutionKey: unique symbol = Symbol("rxcli.commandExecution");

/**
 * C1: a command spec is compiled exactly once. `defineCommand`/`defineCommands`
 * compile and stash the result here; the registry reuses it instead of recomputing
 * `z.toJSONSchema` on every registration path.
 */
export const compiledSchemaKey: unique symbol = Symbol("rxcli.compiledSchema");

export type ResolvedCommandArgs = Record<string, unknown> & {
  [commandExecutionKey]?: CommandExecutionState;
};

export interface CompiledCommandSchema {
  readonly mode: CommandArgsMode;
  readonly descriptors: readonly ArgumentDescriptor[];
  readonly signature: CommandSignature;
  readonly jsonSchema?: Record<string, unknown>;
  resolve(argv: readonly string[], stdin: Readable): Promise<ResolvedCommandArgs>;
}

export function compileCommandSchema(
  commandName: string,
  definition: CommandArgs | undefined,
  policy?: CommandPolicy<any, any>,
): CompiledCommandSchema {
  return new DefaultCommandSchema(commandName, definition, policy);
}

class DefaultCommandSchema implements CompiledCommandSchema {
  readonly mode: CommandArgsMode;
  readonly descriptors: readonly ArgumentDescriptor[];
  readonly signature: CommandSignature;
  readonly jsonSchema?: Record<string, unknown>;
  readonly #schema?: z.ZodObject;
  readonly #byFlag: ReadonlyMap<string, ArgumentDescriptor>;
  readonly #policy?: CommandPolicy<any, any>;

  constructor(
    commandName: string,
    definition: CommandArgs | undefined,
    policy?: CommandPolicy<any, any>,
  ) {
    this.mode = definition?.type === "json" ? "json" : "argv";
    this.#schema = definition?.schema;
    this.#policy = policy;
    if (definition) {
      assertZodObject(commandName, definition.schema);
      this.jsonSchema = z.toJSONSchema(definition.schema, { io: "input" }) as Record<
        string,
        unknown
      >;
    }
    this.descriptors =
      this.mode === "argv" && definition
        ? compileDescriptors(commandName, this.jsonSchema!, definition.pos ?? [])
        : Object.freeze([]);
    this.#byFlag = new Map(
      this.descriptors
        .filter((descriptor) => !descriptor.positional)
        .map((descriptor) => [descriptor.flagName, descriptor]),
    );
    this.signature = Object.freeze({
      positionals: this.descriptors.filter((arg) => arg.positional).map((arg) => arg.signature),
      options: [
        ...(this.mode === "json"
          ? ["[--input <json>]", "[--input-file <path>]"]
          : this.descriptors.filter((arg) => !arg.positional).map((arg) => arg.signature)),
        ...policySignatures(policy),
      ],
    });
  }

  #tokenize(argv: readonly string[]): ParsedCommandTokens {
    return this.mode === "json" ? tokenizeJson(argv, this.#policy) : this.#tokenizeArgv(argv);
  }

  async resolve(argv: readonly string[], stdin: Readable): Promise<ResolvedCommandArgs> {
    const tokens = this.#tokenize(argv);
    const execution = resolveExecution(tokens.options);
    let output: Record<string, unknown>;

    if (!this.#schema) {
      // 无 args 声明的命令:tokenizer 已拒绝一切未知旗标,这里只剩位置参数要拒。
      if (tokens.positionals.length > 0) throw unexpectedPositionals(tokens.positionals);
      output = {};
    } else if (this.mode === "json") {
      const resolved = await resolveJson(tokens.options, stdin, this.#schema);
      output = resolved.data;
      execution.json = resolved.meta;
    } else {
      output = await this.#resolveArgv(tokens);
    }

    if (this.#policy?.mode === "write") validateWriteExecution(execution, this.#policy);
    Object.defineProperty(output, commandExecutionKey, { value: execution, enumerable: false });
    return output as ResolvedCommandArgs;
  }

  #tokenizeArgv(argv: readonly string[]): ParsedCommandTokens {
    const options: Record<string, unknown> = {};
    const positionals: string[] = [];
    let onlyPositionals = false;

    for (let index = 0; index < argv.length; index++) {
      const token = argv[index]!;
      if (!onlyPositionals && token === "--") {
        onlyPositionals = true;
        continue;
      }
      if (onlyPositionals || !token.startsWith("--")) {
        if (
          !onlyPositionals &&
          token.startsWith("-") &&
          token.length > 1 &&
          !isNegativeNumber(token)
        ) {
          throw invalidShortFlag(token);
        }
        positionals.push(token);
        continue;
      }

      const equalsIndex = token.indexOf("=");
      const flagName = token.slice(2, equalsIndex < 0 ? undefined : equalsIndex);
      const inlineValue = equalsIndex < 0 ? undefined : token.slice(equalsIndex + 1);
      const policyType = policyOptionType(flagName, this.#policy);
      const descriptor = this.#byFlag.get(flagName);

      // L1: only interpret `--no-<x>` as negation when `<x>` is NOT itself a declared
      // field. A boolean field literally named e.g. `noCache` (flag `--no-cache`) must
      // be settable via its own flag, not hijacked by the negation heuristic.
      if (!descriptor && flagName.startsWith("no-") && inlineValue === undefined) {
        const positive = flagName.slice(3);
        const positiveDescriptor = this.#byFlag.get(positive);
        if (positiveDescriptor && positiveDescriptor.type === "boolean") {
          options[positiveDescriptor.name] = false;
          continue;
        }
      }
      if (!descriptor && !policyType) throw unknownArgument(flagName);
      const targetName = descriptor?.name ?? flagName;
      const type = descriptor?.type ?? policyType!;
      if (type === "boolean") {
        if (inlineValue !== undefined) {
          options[targetName] = parseBoolean(inlineValue, `--${flagName}`);
        } else {
          options[targetName] = true;
        }
        continue;
      }
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
        throw missingValue(flagName);
      }
      if (inlineValue === undefined) index++;
      setOption(options, targetName, value, type);
    }
    return { options, positionals };
  }

  async #resolveArgv(tokens: ParsedCommandTokens): Promise<Record<string, unknown>> {
    const raw: Record<string, unknown> = {};
    let positionalIndex = 0;
    for (const descriptor of this.descriptors) {
      if (descriptor.positional) {
        const value = tokens.positionals[positionalIndex++];
        if (value !== undefined) raw[descriptor.name] = value;
      } else if (Object.prototype.hasOwnProperty.call(tokens.options, descriptor.name)) {
        raw[descriptor.name] = tokens.options[descriptor.name];
      }
    }
    if (positionalIndex < tokens.positionals.length) {
      throw unexpectedPositionals(tokens.positionals.slice(positionalIndex));
    }
    return validateZod(this.#schema!, raw);
  }
}

function compileDescriptors(
  commandName: string,
  jsonSchema: Record<string, unknown>,
  pos: readonly string[],
): readonly ArgumentDescriptor[] {
  if (jsonSchema.type !== "object" || !isRecord(jsonSchema.properties)) {
    throw new InternalError({
      subtype: "contract_violation",
      message: `defineCommand(${commandName}): args.schema must produce an object`,
    });
  }
  const properties = jsonSchema.properties;
  const required = new Set(
    Array.isArray(jsonSchema.required) ? jsonSchema.required.map(String) : [],
  );
  const positionalNames = new Set(pos);
  if (positionalNames.size !== pos.length) {
    throw new InternalError({
      subtype: "contract_violation",
      message: `defineCommand(${commandName}): args.pos cannot contain duplicate fields`,
    });
  }
  for (const name of pos) {
    if (!(name in properties)) {
      throw new InternalError({
        subtype: "contract_violation",
        message: `defineCommand(${commandName}): positional field "${name}" is not in args.schema`,
      });
    }
  }

  let sawOptionalPositional = false;
  const descriptors = Object.entries(properties).map(([name, property]) => {
    if (!isRecord(property)) {
      throw new InternalError({
        subtype: "contract_violation",
        message: `defineCommand(${commandName}): field "${name}" has no usable JSON Schema`,
      });
    }
    const flagName = toKebabCase(name);
    if (!ARGUMENT_IDENTIFIER.test(flagName)) {
      throw new InternalError({
        subtype: "contract_violation",
        message: `defineCommand(${commandName}): field "${name}" cannot map to a CLI flag`,
      });
    }
    if (RESERVED_ARGUMENT_NAMES.has(flagName)) {
      throw new InternalError({
        subtype: "contract_violation",
        message: `defineCommand(${commandName}): argument --${flagName} is reserved`,
      });
    }
    const positional = positionalNames.has(name);
    const isRequired = required.has(name);
    if (positional) {
      if (!isRequired) sawOptionalPositional = true;
      else if (sawOptionalPositional) {
        throw new InternalError({
          subtype: "contract_violation",
          message: `defineCommand(${commandName}): required positional field "${name}" cannot follow an optional field`,
        });
      }
    }
    const type = propertyType(commandName, name, property);
    const description = typeof property.description === "string" ? property.description : undefined;
    const descriptor: ArgumentDescriptor = {
      name,
      flagName,
      type,
      required: isRequired,
      positional,
      ...(Object.prototype.hasOwnProperty.call(property, "default")
        ? { defaultValue: property.default }
        : {}),
      ...(description ? { description } : {}),
      displayName: positional ? name : `--${flagName}`,
      signature: argumentSignature(flagName, type, positional, isRequired),
    };
    return Object.freeze(descriptor);
  });

  descriptors.sort((left, right) => {
    const leftIndex = pos.indexOf(left.name);
    const rightIndex = pos.indexOf(right.name);
    if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
    if (leftIndex >= 0) return -1;
    if (rightIndex >= 0) return 1;
    return 0;
  });
  return Object.freeze(descriptors);
}

function propertyType(
  commandName: string,
  name: string,
  schema: Record<string, unknown>,
): ArgumentType {
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  if (type === "integer" || type === "number") return "number";
  if (type === "string" || type === "boolean" || type === "array") return type;
  throw new InternalError({
    subtype: "contract_violation",
    message: `defineCommand(${commandName}): argv field "${name}" must be string, number, boolean, or array; use args.type "json" for nested values`,
  });
}

function argumentSignature(
  name: string,
  type: ArgumentType,
  positional: boolean,
  required: boolean,
): string {
  if (positional) return required ? `<${name}>` : `[${name}]`;
  if (type === "boolean") return required ? `--${name}` : `[--${name}]`;
  const value = type === "array" ? "<value>..." : `<${type}>`;
  const token = `--${name} ${value}`;
  return required ? token : `[${token}]`;
}

function tokenizeJson(
  argv: readonly string[],
  policy: CommandPolicy<any, any> | undefined,
): ParsedCommandTokens {
  const options: Record<string, unknown> = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--") {
      if (index !== argv.length - 1) throw unexpectedPositionals(argv.slice(index + 1));
      continue;
    }
    if (!token.startsWith("--")) throw unexpectedPositionals([token]);
    const equals = token.indexOf("=");
    const name = token.slice(2, equals < 0 ? undefined : equals);
    const inline = equals < 0 ? undefined : token.slice(equals + 1);
    const policyType = policyOptionType(name, policy);
    if (
      name === "input" ||
      name === "input-file" ||
      name === "input-schema" ||
      name === "input-example"
    ) {
      const boolean = name === "input-schema" || name === "input-example";
      if (boolean) {
        if (inline !== undefined)
          throw new ValidationError({
            subtype: "invalid_argument",
            param: `--${name}`,
            message: `--${name} does not accept a value`,
          });
        options[name] = true;
        continue;
      }
      const value = inline ?? argv[index + 1];
      if (value === undefined || (inline === undefined && value.startsWith("--")))
        throw missingValue(name);
      if (inline === undefined) index++;
      rejectDuplicateFlag(options, name);
      options[name] = value;
      continue;
    }
    if (!policyType) throw unknownArgument(name);
    if (policyType === "boolean") {
      options[name] = inline === undefined ? true : parseBoolean(inline, `--${name}`);
      continue;
    }
    const value = inline ?? argv[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--")))
      throw missingValue(name);
    if (inline === undefined) index++;
    rejectDuplicateFlag(options, name);
    options[name] = value;
  }
  return { options, positionals: [] };
}

function resolveExecution(options: Record<string, unknown>): CommandExecutionState {
  return {
    dryRun: options["dry-run"] === true,
    confirmed: options.yes === true,
    ...(typeof options["idempotency-key"] === "string"
      ? { idempotencyKey: options["idempotency-key"] as string }
      : {}),
  };
}

function validateWriteExecution(
  execution: CommandExecutionState,
  policy: Extract<CommandPolicy<any, any>, { mode: "write" }>,
): void {
  if (execution.dryRun && !policy.dryRun) {
    throw new ValidationError({
      subtype: "invalid_argument",
      param: "--dry-run",
      message: "This command does not support --dry-run",
    });
  }
  if (policy.idempotency === "required" && !execution.dryRun && !execution.idempotencyKey?.trim()) {
    throw new ValidationError({
      subtype: "missing_required",
      param: "--idempotency-key",
      message: "Missing required argument --idempotency-key",
      hint: "Generate one key and reuse it for retries of the same operation.",
    });
  }
}

function policyOptionType(
  name: string,
  policy: CommandPolicy<any, any> | undefined,
): ArgumentType | undefined {
  if (policy?.mode !== "write") return undefined;
  if (name === "dry-run" && policy.dryRun) return "boolean";
  if (name === "yes" && policy.confirmation === "required") return "boolean";
  if (name === "idempotency-key" && policy.idempotency) return "string";
  return undefined;
}

function policySignatures(policy: CommandPolicy<any, any> | undefined): string[] {
  if (policy?.mode !== "write") return [];
  return [
    ...(policy.dryRun ? ["[--dry-run]"] : []),
    ...(policy.confirmation === "required" ? ["[--yes]"] : []),
    ...(policy.idempotency
      ? [
          policy.idempotency === "required"
            ? "--idempotency-key <string>"
            : "[--idempotency-key <string>]",
        ]
      : []),
  ];
}

function setOption(
  options: Record<string, unknown>,
  name: string,
  value: string,
  type: ArgumentType,
): void {
  if (type !== "array") {
    rejectDuplicateFlag(options, name);
    options[name] = value;
    return;
  }
  const current = options[name];
  options[name] = current === undefined ? [value] : [...(current as unknown[]), value];
}

/** 非 array 旗标重复出现必须报错(与 argv 模式一致),幂等键尤其不能静默覆盖。 */
function rejectDuplicateFlag(options: Record<string, unknown>, name: string): void {
  if (Object.prototype.hasOwnProperty.call(options, name)) {
    throw new ValidationError({
      subtype: "invalid_argument",
      param: `--${toKebabCase(name)}`,
      message: `Argument --${toKebabCase(name)} cannot be repeated`,
    });
  }
}

function assertZodObject(commandName: string, schema: unknown): asserts schema is z.ZodObject {
  if (!(schema instanceof z.ZodObject)) {
    throw new InternalError({
      subtype: "contract_violation",
      message: `defineCommand(${commandName}): args.schema must be a Zod object schema`,
    });
  }
}

function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function parseBoolean(value: string, param: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ValidationError({
    subtype: "invalid_argument",
    param,
    message: `${param} must be true, false, 1, or 0`,
  });
}

function missingValue(name: string): ValidationError {
  return new ValidationError({
    subtype: "missing_required",
    param: `--${name}`,
    message: `Argument --${name} requires a value`,
  });
}

function unknownArgument(name: string): ValidationError {
  return new ValidationError({
    subtype: "invalid_argument",
    param: `--${name}`,
    message: `Unknown argument --${name}`,
  });
}

function unexpectedPositionals(values: readonly string[]): ValidationError {
  return new ValidationError({
    subtype: "invalid_argument",
    param: values[0],
    message: `Unexpected positional argument(s): ${values.join(" ")}`,
  });
}

function invalidShortFlag(token: string): ValidationError {
  return new ValidationError({
    subtype: "invalid_argument",
    param: token,
    message: `Unknown short flag ${token} (only long flags are declared by command schemas)`,
    hint: `Use -- before a positional value that starts with '-': command -- ${token}`,
  });
}

function isNegativeNumber(token: string): boolean {
  return /^-\d+(\.\d+)?$/.test(token);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
