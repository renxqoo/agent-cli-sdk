import { expectTypeOf } from "vitest";
import * as z from "zod";
import { defineCommand, type CommandArgs, type NoArgs } from "../src/index.js";

const ArgvSchema = z.object({
  id: z.string(),
  limit: z.coerce.number().default(20),
  status: z.enum(["open", "closed"]).optional(),
});

defineCommand({
  name: "get",
  description: "get",
  args: { schema: ArgvSchema, pos: ["id"] },
  async run(ctx, args) {
    expectTypeOf(ctx.state).toEqualTypeOf<unknown>();
    expectTypeOf(args).toEqualTypeOf<{
      id: string;
      limit: number;
      status?: "open" | "closed" | undefined;
    }>();
    return { data: args };
  },
});

defineCommand({
  name: "zod",
  description: "Zod uses the direct command contract",
  args: { schema: z.object({ id: z.string().uuid() }), pos: ["id"] },
  async run(_ctx, args) {
    expectTypeOf(args.id).toEqualTypeOf<string>();
    return { data: args };
  },
});

defineCommand({
  name: "create",
  description: "create",
  args: { type: "json", schema: z.object({ customerId: z.string() }) },
  async run(_ctx, args) {
    expectTypeOf(args).toEqualTypeOf<{ customerId: string }>();
    return { data: args };
  },
});

defineCommand({
  name: "health",
  description: "health",
  async run(_ctx, args) {
    expectTypeOf(args).toEqualTypeOf<NoArgs>();
    return { data: null };
  },
});

const invalidPosition: CommandArgs<typeof ArgvSchema> = {
  schema: ArgvSchema,
  // @ts-expect-error `missing` is not a field in the Zod object.
  pos: ["missing"],
};
void invalidPosition;

const invalidJsonPosition: CommandArgs<typeof ArgvSchema> = {
  type: "json",
  schema: ArgvSchema,
  // @ts-expect-error JSON mode cannot declare positional operands.
  pos: ["id"],
};
void invalidJsonPosition;

defineCommand({
  name: "removed-contract",
  description: "removed",
  // @ts-expect-error the old `input` contract was deleted.
  input: { schema: ArgvSchema },
  async run() {
    return { data: null };
  },
});
