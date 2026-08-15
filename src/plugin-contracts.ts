import type { CommandGroup } from "./command-contracts.js";
import type { CommandResult, StructuredData } from "./output-contracts.js";
import type { RequestAttemptEvent, RequestOptions } from "./request-contracts.js";
import type { CommandContext } from "./runtime-contracts.js";
import type { JsonInputMeta } from "./json-input.js";
import type { LocalState } from "./local-state.js";

export interface CommandInputEvent {
  route: readonly string[];
  meta: Readonly<JsonInputMeta>;
  /** A defensive clone with schema-metadata sensitive JSON pointers replaced. */
  redactedArgs: unknown;
}

/**
 * Services resolved by the app assembler and handed to every plugin during the
 * assembly phase (`apply`). This is the only channel through which plugins receive
 * the app's local state — plugin factories take no directory parameters.
 */
export interface AppServices {
  /** The app's single local-state object (file or memory). */
  localState: LocalState;
  /** App name (`DefineCliOptions.name`). */
  appName: string;
  /** CLI binary name (`DefineCliOptions.binName`), when declared. */
  binName?: string;
}

/** Fired once per `app.run` invocation, before routing. */
export interface AppRunEvent {
  argv: readonly string[];
}

/** Fired once per `app.run` invocation, after the run settles (every path). */
export interface AppExitEvent {
  argv: readonly string[];
  exitCode: number;
}

export type UnauthorizedDecision =
  | { action: "retry" }
  | { action: "decline" }
  | { action: "reject"; error: unknown };

export type ErrorDecision =
  | { action: "pass" }
  | { action: "replace"; error: unknown }
  | { action: "recover"; result?: CommandResult<StructuredData> };

export interface Plugin<State = Record<string, never>> {
  name: string;
  enforce?: "pre" | "normal" | "post";
  /**
   * Assembly-phase hook, invoked once by `defineCliApp` (or manually via `applyPlugins`)
   * before command routing compiles. Plugins resolve shared services here — typically
   * `services.localState.store` — and may populate `provides` and close over their
   * runtime state. A thrown error aborts startup.
   */
  apply?(services: Readonly<AppServices>): void | Promise<void>;
  provides?: {
    namespaces?: Record<string, CommandGroup<State>>;
    commands?: CommandGroup<State>;
  };
  /**
   * App-level lifecycle: fires exactly once per `app.run` — including help, --version,
   * unknown routes, and error paths. Best-effort only; failures are isolated and silent.
   * Use for operational concerns (e.g. update awareness), never business output.
   */
  onAppRun?(event: Readonly<AppRunEvent>): void | Promise<void>;
  afterAppRun?(event: Readonly<AppExitEvent>): void | Promise<void>;
  beforeCommand?(context: CommandContext<State>): Promise<void>;
  observeInput?(context: CommandContext<State>, event: Readonly<CommandInputEvent>): Promise<void>;
  beforeRequest?(
    context: CommandContext<State>,
    request: Readonly<RequestOptions>,
  ): Promise<RequestOptions>;
  observeRequest?(
    context: CommandContext<State>,
    event: Readonly<RequestAttemptEvent>,
  ): Promise<void>;
  handleUnauthorized?(
    context: CommandContext<State>,
    event: Readonly<RequestAttemptEvent>,
  ): Promise<UnauthorizedDecision | undefined>;
  transformOutput?(
    context: CommandContext<State>,
    data: Readonly<StructuredData>,
  ): Promise<StructuredData>;
  observeError?(context: CommandContext<State>, error: unknown): Promise<void>;
  handleError?(context: CommandContext<State>, error: unknown): Promise<ErrorDecision | undefined>;
}
