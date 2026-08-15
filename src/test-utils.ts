/**
 * @renxqoo/agent-cli-sdk —— createTestCtx(测试用 mock ctx)
 *
 * 设计依据:docs/02-sdk-guide.md "测试:vitest + createTestCtx"。
 * 业务包用它 mock ctx 测 run 逻辑:mock request 方法(高层 get/post 都走 request,
 * mock request 即可覆盖全部业务逻辑),不需要起真实 server。
 */

import type {
  CommandContext,
  RequestOptions,
  TransportResponse,
  PipeApi,
  LogApi,
} from "./types.js";
import { createContext } from "./context.js";

/** mock 的 request 函数:接收 RequestOptions,返回 TransportResponse。 */
export type MockRequest = (opts: RequestOptions) => Promise<TransportResponse> | TransportResponse;

export interface CreateTestCtxOptions<State> {
  /** mock request(高层 get/post 都走它)。不传则返回空 200。 */
  request?: MockRequest;
  /** 初始 state。 */
  state?: State;
  /** 自定义 log(默认静默,不污染测试输出)。 */
  log?: LogApi;
  /** 自定义 pipe。 */
  pipe?: PipeApi;
}

/**
 * 创建测试用 ctx。业务包直接调 run(ctx, args) 测逻辑:
 *
 * ```ts
 * const ctx = createTestCtx({
 *   request: async (opts) => {
 *     if (opts.path === '/orders') return { status: 200, data: { items: [...] }, headers: {} }
 *     throw new Error(`unexpected ${opts.path}`)
 *   },
 * })
 * const result = await cmd.run(ctx, { limit: 30 })
 * expect(result.data).toEqual([...])
 * ```
 */
export function createTestCtx<State = Record<string, never>>(
  opts: CreateTestCtxOptions<State> = {},
): CommandContext<State> {
  const adapter = {
    send: async <T = unknown>(reqOpts: Readonly<RequestOptions>) => {
      const res = opts.request
        ? await opts.request(reqOpts as RequestOptions)
        : { status: 200, data: undefined, headers: {} };
      return {
        kind: "response" as const,
        response: res as TransportResponse<T>,
      };
    },
  };

  return createContext<State>({
    state: (opts.state ?? {}) as State,
    adapter,
    log: opts.log ?? createSilentLog(),
    pipe: opts.pipe ?? createEmptyTestPipe(),
  });
}

/** 静默 log(测试默认不输出)。 */
function createSilentLog(): LogApi {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** 测试用空 pipe。 */
function createEmptyTestPipe(): PipeApi {
  return {
    async *in() {
      /* 无数据 */
    },
    isInPipe() {
      return false;
    },
  };
}
