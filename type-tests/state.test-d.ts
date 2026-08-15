import {
  defineCli,
  defineCommand,
  defineCommands,
  type CommandContext,
  type CommandGroup,
} from "../src/index.js";

interface AppState {
  user: {
    id: string;
  };
}

const commands = defineCommands<AppState>({
  contextual: {
    name: "contextual",
    description: "Contextually type group commands",
    async run(ctx) {
      const id: string = ctx.state.user.id;
      // @ts-expect-error contextual State must also reject undeclared fields.
      void ctx.state.token;
      return { data: { id } };
    },
  },
  profile: defineCommand<{ id: string }, AppState>({
    name: "profile",
    description: "Read the current profile",
    async run(ctx) {
      const id: string = ctx.state.user.id;

      // The command state must not silently degrade to `any`.
      // @ts-expect-error `missing` is not part of AppState.
      void ctx.state.missing;

      return { data: { id } };
    },
  }),
});

defineCli<AppState>({
  name: "typed-state",
  createState: () => ({ user: { id: "test" } }),
  description: "State typing fixture",
  commands,
});

const wrongStateCommands: CommandGroup<{ token: string }> = {
  token: defineCommand<{ token: string }, { token: string }>({
    name: "token",
    description: "Read token",
    async run(ctx) {
      return { data: { token: ctx.state.token } };
    },
  }),
};

defineCli<AppState>({
  name: "wrong-state",
  createState: () => ({ user: { id: "test" } }),
  description: "Reject incompatible command state",
  // @ts-expect-error commands requiring another State cannot be mounted.
  commands: wrongStateCommands,
});

declare const ctx: CommandContext<AppState>;
const userId: string = ctx.state.user.id;
void userId;
