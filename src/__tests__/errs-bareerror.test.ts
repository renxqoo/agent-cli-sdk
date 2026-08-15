/**
 * BUG-14 红测:BareError 经 toCliError 类型自洽。
 * 现状:toCliError 里 `as unknown as CliError` 类型撒谎,BareError 无 category/subtype,
 *      任何走 serializeError(BareError) 的路径会产出 type/subtype: undefined。
 * 最优解:BareError 加 category/subtype 只读字段,pipeline 仍单独处理 exitCode。
 */
import { describe, it, expect } from "vitest";
import { BareError, toCliError } from "../errs/index.js";
import { serializeError } from "../envelope.js";

describe("BUG-14: BareError 类型自洽(category/subtype 非空)", () => {
  it("toCliError(new BareError(2)) 返回的对象有 category 与 subtype", () => {
    const cliErr = toCliError(new BareError(2));
    expect(cliErr.category).toBeDefined();
    expect(cliErr.subtype).toBeDefined();
    expect(typeof cliErr.category).toBe("string");
    expect(typeof cliErr.subtype).toBe("string");
  });

  it("BareError 自身暴露 category/subtype(不再依赖 as 强转)", () => {
    const e = new BareError(3);
    expect((e as { category?: string }).category).toBeDefined();
    expect((e as { subtype?: string }).subtype).toBeDefined();
  });

  it("serializeError 不会产出 type:undefined(防御性:即便误走 serialize 路径)", () => {
    const cliErr = toCliError(new BareError(1));
    const wire = JSON.parse(serializeError(cliErr));
    expect(wire.error.type).toBeDefined();
    expect(wire.error.subtype).toBeDefined();
  });

  it("exitCode 仍可读(向后兼容)", () => {
    expect(new BareError(2).exitCode).toBe(2);
  });
});
