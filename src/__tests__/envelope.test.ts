import { describe, it, expect } from "vitest";
import {
  serializeSuccess as serializeSuccessEnvelope,
  serializeError,
  type SerializeSuccessOptions,
} from "../envelope.js";
import type { Meta } from "../types.js";
import {
  ValidationError,
  NotFoundError,
  PermissionError,
  NetworkError,
  InternalError,
  exitCodeOf,
} from "../errs/index.js";

function serializeSuccess(
  data: unknown,
  meta?: Meta,
  options: Omit<SerializeSuccessOptions, "source"> = {},
): string {
  return serializeSuccessEnvelope(data, meta, { source: "test", ...options });
}

describe("envelope: 成功输出序列化", () => {
  it("基础结构 {ok, data, meta}", () => {
    const out = serializeSuccess([{ id: "o1" }], { count: 1 });
    const env = JSON.parse(out);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual([{ id: "o1" }]);
    expect(env.meta.count).toBe(1);
  });

  it("骨架 nextToken → next_token(snake_case),data 原样", () => {
    // data 里的 camelCase 业务字段不该被转
    const out = serializeSuccess(
      { userId: "u1", orderCount: 3 },
      { pagination: { complete: false, nextToken: "abc" } },
    );
    const env = JSON.parse(out);
    // data 业务字段原样(不被转成 user_id / order_count)
    expect(env.data.userId).toBe("u1");
    expect(env.data.orderCount).toBe(3);
    // 骨架字段转 snake
    expect(env.meta.pagination.complete).toBe(false);
    expect(env.meta.pagination.next_token).toBe("abc");
  });

  it("identity 注入(传入才填)", () => {
    expect(JSON.parse(serializeSuccess([], undefined)).identity).toBeUndefined();
    expect(JSON.parse(serializeSuccess([], undefined, { identity: "user" })).identity).toBe("user");
  });

  // D4: 成功输出顶层支持 dry_run / _notice(03-envelopes.md:55-56 契约)。
  // dry_run 出现时为 true;_notice 是信息性字段(版本更新/skill 漂移)。
  it("D4: dry_run + _notice 顶层字段(03-envelopes.md 契约)", () => {
    const out = serializeSuccess({ ok: true }, undefined, {
      identity: "user",
      dryRun: true,
      notice: { update: { current: "1.2.0", latest: "1.3.0" } },
    });
    const env = JSON.parse(out);
    expect(env.dry_run).toBe(true);
    expect(env._notice).toEqual({ update: { current: "1.2.0", latest: "1.3.0" } });
  });

  it("D4: 不传 dry_run/_notice 时省略(正常请求)", () => {
    const env = JSON.parse(serializeSuccess({ ok: true }));
    expect(env.dry_run).toBeUndefined();
    expect(env._notice).toBeUndefined();
  });

  it("空数组仍是合法统一输出格式", () => {
    const env = JSON.parse(serializeSuccess([], { count: 0, pagination: { complete: true } }));
    expect(env.ok).toBe(true);
    expect(env.data).toEqual([]);
    expect(env.meta.pagination.complete).toBe(true);
  });

  // H2: Meta 类型声明 [key: string]: unknown(types.ts:79),非骨架字段应原样透传,
  // 不应被 transformMeta 的白名单丢弃。builtin.ts 的 skills list 返回 meta.path 就是这种业务字段。
  it("H2: meta 非骨架字段(如 path)原样透传,不被丢弃", () => {
    const out = serializeSuccess([{ id: "o1" }], { count: 1, path: "orders/references" });
    const env = JSON.parse(out);
    expect(env.meta.count).toBe(1);
    expect(env.meta.path).toBe("orders/references"); // 当前被 transformMeta 丢弃
  });

  it("H2: 多个业务 meta 字段都透传", () => {
    const out = serializeSuccess([1], {
      count: 1,
      source: "cache",
      requestId: "r_123",
      nested: { a: 1 },
    });
    const env = JSON.parse(out);
    expect(env.meta.source).toBe("cache");
    expect(env.meta.requestId).toBe("r_123");
    expect(env.meta.nested).toEqual({ a: 1 });
  });

  it("下划线前缀也是普通业务 meta，不承载运行时能力", () => {
    const out = serializeSuccess([1], { count: 1, _internal: "secret", _rawOutput: true });
    const env = JSON.parse(out);
    expect(env.meta.count).toBe(1);
    expect(env.meta._internal).toBe("secret");
    expect(env.meta._rawOutput).toBe(true);
  });
});

describe("envelope: 错误输出序列化", () => {
  it("NotFoundError: type/subtype/code/message", () => {
    const out = serializeError(new NotFoundError("订单 o_1001 不存在"));
    const env = JSON.parse(out);
    expect(env.ok).toBe(false);
    expect(env.error.type).toBe("api");
    expect(env.error.subtype).toBe("not_found");
    expect(env.error.code).toBe(404);
    expect(env.error.message).toBe("订单 o_1001 不存在");
  });

  it("PermissionError: missingScopes → missing_scopes", () => {
    const out = serializeError(
      new PermissionError({
        subtype: "missing_scope",
        message: "缺少权限",
        missingScopes: ["orders:read"],
      }),
    );
    const env = JSON.parse(out);
    expect(env.error.type).toBe("authorization");
    expect(env.error.missing_scopes).toEqual(["orders:read"]);
  });

  it("ValidationError: param 原样(flag 带 --)", () => {
    const out = serializeError(
      new ValidationError({ subtype: "invalid_argument", param: "--limit", message: "必须为正数" }),
    );
    const env = JSON.parse(out);
    expect(env.error.type).toBe("validation");
    expect(env.error.param).toBe("--limit");
  });

  it("retryable 字段透传", () => {
    const env = JSON.parse(
      serializeError(new NetworkError({ subtype: "timeout", message: "超时", retryable: true })),
    );
    expect(env.error.retryable).toBe(true);
  });
});

describe("errs: exit code 映射", () => {
  it("9 类 category → exit code", () => {
    expect(exitCodeOf("api")).toBe(1);
    expect(exitCodeOf("validation")).toBe(2);
    expect(exitCodeOf("authentication")).toBe(3);
    expect(exitCodeOf("authorization")).toBe(3);
    expect(exitCodeOf("config")).toBe(3);
    expect(exitCodeOf("network")).toBe(4);
    expect(exitCodeOf("internal")).toBe(5);
    expect(exitCodeOf("policy")).toBe(6);
    expect(exitCodeOf("confirmation")).toBe(10);
  });

  it("裸 Error 兜底成 InternalError(unknown)", () => {
    const err = new Error("boom");
    const internal = new InternalError({ subtype: "unknown", message: err.message, cause: err });
    expect(exitCodeOf(internal.category)).toBe(5);
    expect(internal.subtype).toBe("unknown");
  });
});
