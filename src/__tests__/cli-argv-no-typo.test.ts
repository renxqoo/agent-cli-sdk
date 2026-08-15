/**
 * BUG-9 红测:`--no-<typo>` 不应吞下一个 token 作为值。
 * 现状:`--no-verbos`(拼错的 boolean)→ 不命中 no- 分支也不命中 boolean 分支
 *      → 落到值解析 → 吞下一个非 `-` token 作值,静默且丢失 positional。
 * 最优解:`--no-` 前缀对未知 key 抛 unknown_flag(提示可能是拼写错误),而非当值 flag 处理。
 */
import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { compileCommandSchema } from "../command-schema.js";
import { ValidationError } from "../errs/index.js";
import * as z from "zod";

function resolve(tokens: string[], args: Parameters<typeof compileCommandSchema>[1]) {
  return compileCommandSchema("command", args).resolve(tokens, Readable.from([]));
}

describe("BUG-9: --no-<typo> 不吞下一个 token 作为值", () => {
  it("--no-verbos(拼错的 boolean)→ 抛 unknown_flag,提示可能拼写错误", async () => {
    const argsSpec = { schema: z.object({ verbose: z.boolean().default(false) }) };
    await expect(resolve(["--no-verbos", "foo"], argsSpec)).rejects.toBeInstanceOf(ValidationError);
    await expect(resolve(["--no-verbos", "foo"], argsSpec)).rejects.toThrow(/--no-verbos|unknown/i);
  });

  it("--no-verbose(正确的 boolean)仍正常解析为 false", async () => {
    const argsSpec = { schema: z.object({ verbose: z.boolean().default(false) }) };
    await expect(resolve(["--no-verbose"], argsSpec)).resolves.toEqual({ verbose: false });
  });

  it("--no-verbos 不吞 'foo':foo 应保留为 positional(或抛错后整体不解析)", async () => {
    const argsSpec = {
      schema: z.object({ verbose: z.boolean().default(false), name: z.string().optional() }),
      pos: ["name"],
    } as const;
    // 抛错即证明 foo 没被悄悄吃掉
    await expect(resolve(["--no-verbos", "foo"], argsSpec)).rejects.toThrow();
  });

  it("--no-未知(无对应 boolean)也应抛 unknown_flag", async () => {
    await expect(resolve(["--no-unknown"], undefined)).rejects.toBeInstanceOf(ValidationError);
  });
});
