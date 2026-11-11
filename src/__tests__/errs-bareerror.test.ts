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
  it("serializeError 不会产出 type:undefined(防御性:即便误走 serialize 路径)", () => {
    const cliErr = toCliError(new BareError(1));
    const wire = JSON.parse(serializeError(cliErr));
    expect(wire.error.type).toBe("internal");
    expect(wire.error.subtype).toBe("bare_exit");
  });
});
