/**
 * AuthFlow 策略契约(L3)。
 *
 * 每种 OAuth flow 实现这个接口。框架(defineAuth)根据 flow 类型选择策略,
 * 调用 login() 拿 TokenInfo,然后统一处理存储/身份/续期。
 */

import type { OAuthClientConfig, TokenInfo, PollResult } from "../oauth.js";
import type { BrowserOpener } from "../infra/browser.js";

export type FlowType = "device" | "authorization_code" | "client_credentials";

/** 各 flow 共享的基础依赖。 */
interface BaseFlowDeps {
  /** OAuth 客户端配置(baseUrl + clientId/clientSecret)。 */
  cfg: OAuthClientConfig;
  /** 业务声明的 scope(client_credentials 续期时可被持久化的已授予 scopes 覆盖)。 */
  scope?: string;
  /** 日志输出(进度提示)。 */
  log?: { info(...args: unknown[]): void };
}

/** device flow 专用依赖(RFC 8628)。 */
export interface DeviceFlowDeps extends BaseFlowDeps {
  type: "device";
  /** device flow 轮询函数(测试注入)。 */
  poller?: (cfg: OAuthClientConfig, deviceCode: string) => Promise<PollResult>;
  /** split-flow:--no-wait(申请设备码但不轮询,返回 url 给 agent)。 */
  noWait?: boolean;
  /** split-flow:--device-code(用已有设备码恢复轮询)。 */
  resumeDeviceCode?: string;
}

/** authorization_code + PKCE flow 专用依赖(RFC 6749 §4.1 + RFC 7636)。 */
export interface AuthCodeFlowDeps extends BaseFlowDeps {
  type: "authorization_code";
  /** OAuth state(测试注入;不传=随机生成)。 */
  state?: string;
  /** 浏览器打开器。 */
  browser?: BrowserOpener;
  /** 本地回调端口(不传=随机)。 */
  callbackPort?: number;
}

/** client_credentials flow 专用依赖(RFC 6749 §4.4)。 */
export interface ClientCredentialsFlowDeps extends BaseFlowDeps {
  type: "client_credentials";
}

/**
 * C2: Flow 执行依赖是按 `type` 判别的联合,编译期即可阻止把 device 字段塞进
 * authCode 依赖(反之亦然)。各 flow 在 login/refresh 内按 type 收窄读取自有字段。
 */
export type FlowDeps = DeviceFlowDeps | AuthCodeFlowDeps | ClientCredentialsFlowDeps;

/**
 * 认证流程策略。每个 OAuth flow 实现此接口。
 * login/refresh 接收完整 FlowDeps 联合,内部按 `deps.type` 收窄。
 */
export interface AuthFlow {
  /** flow 类型标识。 */
  readonly type: FlowType;

  /**
   * 执行登录,返回 token 信息。
   * 不含落盘逻辑——框架统一存储(login 只负责"怎么拿 token")。
   */
  login(deps: FlowDeps): Promise<TokenInfo>;

  /**
   * 续期(401 刷新时调)。可选——不实现 = 框架用默认 OAuthClient.refresh。
   * 只有 client_credentials 覆盖(它没有 refresh_token,重新 login)。
   */
  refresh?(deps: FlowDeps): Promise<TokenInfo>;
}
