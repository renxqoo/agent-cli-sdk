import type { CommandGroup } from "./command-contracts.js";
import type { Plugin } from "./plugin-contracts.js";
import type { ErrorOnStatus } from "./request-contracts.js";
import type { SkillTarget } from "./skills/targets.js";

export interface DefineCliBaseOptions<State> {
  name: string;
  binName?: string;
  description: string;
  plugins?: Plugin<State>[];
  commands: CommandGroup<State>;
  namespaces?: Record<string, CommandGroup<State>>;
  skillsDir?: string;
  skillsSource?: string;
  skillsTargets?: SkillTarget[];
  errorOnStatus?: ErrorOnStatus;
  baseUrl?: string;
  defaultFormat?: "json" | "human" | "auto";
  messages?: Record<string, unknown>;
}

export type DefineCliOptions<State> = DefineCliBaseOptions<State> &
  ([State] extends [Record<string, never>]
    ? { createState?: () => State }
    : { createState: () => State });

export interface App {
  name: string;
  run(argv: string[]): Promise<void>;
}
