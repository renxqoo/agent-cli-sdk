import { describe, expect, it } from "vitest";
import { defineCli, defineCommand, defineCommands } from "../define.js";

const command = (name: string) =>
  defineCommand({
    name,
    description: `${name} command`,
    async run() {
      return { data: null };
    },
  });

describe("CommandRegistry invariants", () => {
  it("uses one canonical route identity", () => {
    expect(() => defineCommands({ alias: command("actual") })).toThrow(
      /route key "alias" must equal command name "actual"/,
    );
  });

  it.each(["", " ", "Bad Name", "two words", "_private", "../outside"])(
    "rejects an unreachable command identifier %j",
    (name) => {
      expect(() =>
        defineCommand({
          name,
          description: "invalid",
          async run() {},
        }),
      ).toThrow(/identifier/);
    },
  );

  it("rejects invalid namespace route segments during app construction", () => {
    expect(() =>
      defineCli({
        name: "demo",
        description: "demo",
        commands: {},
        namespaces: { "bad namespace": { list: command("list") } },
      }),
    ).toThrow(/namespace.*identifier/);
  });

  it.each(["0", "99", "600", "999", "0xx", "6xx", "9xx", "50x"])(
    "rejects impossible HTTP mapping key %s",
    (status) => {
      expect(() =>
        defineCli({
          name: "demo",
          description: "demo",
          commands: {},
          errorOnStatus: { [status]: "server_error" },
        }),
      ).toThrow(/invalid status key/);
    },
  );

  it.each(["100", "599", "1xx", "5xx"])("accepts valid HTTP mapping key %s", (status) => {
    expect(() =>
      defineCli({
        name: "demo",
        description: "demo",
        commands: {},
        errorOnStatus: { [status]: "server_error" },
      }),
    ).not.toThrow();
  });

  it("creates fresh typed state for every command run", async () => {
    const seen: number[] = [];
    const app = defineCli<{ count: number }>({
      name: "stateful",
      description: "stateful",
      createState: () => ({ count: 0 }),
      commands: {
        increment: defineCommand<Record<string, never>, null, { count: number }>({
          name: "increment",
          description: "increment",
          async run(ctx) {
            ctx.state.count++;
            seen.push(ctx.state.count);
            return { data: null };
          },
        }),
      },
    });

    await app.run(["increment"]);
    await app.run(["increment"]);

    expect(seen).toEqual([1, 1]);
  });
});
