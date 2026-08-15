/**
 * device flow 策略(RFC 8628)。
 *
 * 完整 device flow 逻辑(含 split-flow)都在这里,L4 只负责捕获 SplitFlowSignal。
 *
 * 三种 login 模式(通过 FlowDeps 控制):
 *   1. 正常(noWait=false, resumeDeviceCode=undef):申请设备码 → 阻塞轮询
 *   2. --no-wait:申请设备码 → 抛 SplitFlowSignal(含 url),不轮询
 *   3. --device-code:不申请,直接用已有设备码轮询
 */
import { deviceAuthorization, pollDeviceToken, type TokenInfo, type PollResult } from "../oauth.js";
import { AuthenticationError } from "../errs/index.js";
import type { AuthFlow, FlowDeps } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * L6: defaults for split-flow resume. The original device code's real expires_in /
 * interval are not recoverable from the bare --device-code string, so resume uses a
 * conservative interval (NOT the old 100 ms, which would poll ~9000 times over the
 * TTL and trip server rate-limiting) and a 15-minute TTL.
 */
const RESUME_INTERVAL_MS = 2_000;
const RESUME_TTL_SEC = 15 * 60;

/**
 * SplitFlow 信号:--no-wait 时 login() 抛此对象(不是 Error 子类,框架用 instanceof 检测)。
 * 框架捕获后把 deviceCode/verificationUrl 返回给调用方(agent)。
 */
export class SplitFlowSignal {
  constructor(
    public readonly deviceCode: string,
    public readonly userCode: string,
    public readonly verificationUrl: string,
    public readonly verificationUriComplete: string | undefined,
    public readonly verificationUri: string,
    public readonly expiresIn: number,
    public readonly interval: number,
  ) {}
}

/**
 * 轮询 device token 直到拿到/超时/失败(RFC 8628)。
 * 收到 slow_down 时 interval 增加 5 秒(§3.2)。
 */
async function pollForToken(
  cfg: FlowDeps["cfg"],
  deviceCode: string,
  ttlSec: number,
  intervalMs: number,
  poller: (cfg: FlowDeps["cfg"], deviceCode: string) => Promise<PollResult>,
): Promise<TokenInfo> {
  let interval = intervalMs;
  const deadline = Date.now() + ttlSec * 1000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(interval, remaining));
    if (Date.now() >= deadline) break;
    const r = await poller(cfg, deviceCode);
    if (r.status === "ok") return r.token;
    if (r.status === "slow_down") {
      interval += 5000;
      continue;
    }
    if (r.status === "pending") continue;
    // L12: a denied/expired device poll is an expired/failed authorization, not a
    // revocation of an existing token. Reserve `token_revoked` for real revocation.
    throw new AuthenticationError({
      subtype: "token_expired",
      message: `Login failed: ${r.message}`,
    });
  }
  throw new AuthenticationError({
    subtype: "token_expired",
    message: "Login timed out, please retry",
  });
}

export const deviceFlow: AuthFlow = {
  type: "device" as const,

  async login(deps: FlowDeps): Promise<TokenInfo> {
    if (deps.type !== "device") {
      throw new TypeError(`deviceFlow.login received non-device deps (${deps.type})`);
    }
    const poller = deps.poller ?? pollDeviceToken;

    // 模式 3:--device-code(恢复轮询,不重新申请)
    if (deps.resumeDeviceCode) {
      deps.log?.info("\nResuming login (polling with existing device_code)...");
      return pollForToken(
        deps.cfg,
        deps.resumeDeviceCode,
        RESUME_TTL_SEC,
        RESUME_INTERVAL_MS,
        poller,
      );
    }

    // 申请设备码(模式 1 和 2 都需要)
    const info = await deviceAuthorization(deps.cfg, deps.scope);
    const url = info.verification_uri_complete ?? info.verification_uri;

    // 模式 2:--no-wait(申请了但不轮询,抛信号让框架返回 url)
    if (deps.noWait) {
      throw new SplitFlowSignal(
        info.device_code,
        info.user_code,
        url,
        info.verification_uri_complete,
        info.verification_uri,
        info.expires_in,
        info.interval,
      );
    }

    // 模式 1:正常(阻塞轮询)
    deps.log?.info(
      `\nPlease complete login in your browser:\n  ${url}\n  user code: ${info.user_code}\n\nWaiting for login to complete...`,
    );
    return pollForToken(deps.cfg, info.device_code, info.expires_in, info.interval * 1000, poller);
  },
  // 不实现 refresh → 框架用默认 OAuthClient.refresh
};
