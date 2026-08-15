/**
 * device flow split-flow 重构测试。
 *
 * 验证 split-flow 逻辑从 auth/index.ts 移到 flows/device.ts:
 * - --no-wait → login() 抛 SplitFlowResult(含 device_code + url),框架捕获后返回 JSON
 * - --device-code → login() 直接轮询,不重新申请设备码
 * - 正常 login() → 申请设备码 + 阻塞轮询(不变)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deviceFlow, SplitFlowSignal } from "../flows/device.js";
import type { FlowDeps } from "../flows/types.js";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseDeps: FlowDeps = {
  type: "device",
  cfg: { baseUrl: "http://test", clientId: "cid", clientSecret: "csec" },
  scope: "orders:read offline_access",
  log: { info: vi.fn() },
};

describe("device flow:正常 login(阻塞轮询)", () => {
  it("申请设备码 → 轮询 → 返回 TokenInfo", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        device_code: "dc_123",
        user_code: "ABCD-EFGH",
        verification_uri: "http://test/verify",
        expires_in: 600,
        interval: 1,
      }),
    );
    const mockPoller = vi.fn();
    mockPoller.mockResolvedValueOnce({ status: "pending" });
    mockPoller.mockResolvedValueOnce({
      status: "ok",
      token: { access_token: "AT", expires_in: 3600, refresh_token: "RT", scope: "orders:read" },
    });

    const token = await deviceFlow.login({ ...baseDeps, poller: mockPoller });
    expect(token.access_token).toBe("AT");
    expect(token.refresh_token).toBe("RT");
  });
});

describe("device flow:--no-wait split-flow", () => {
  it("抛 SplitFlowSignal(含 device_code + verification_url)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        device_code: "dc_split",
        user_code: "WXYZ-1234",
        verification_uri: "http://test/verify",
        verification_uri_complete: "http://test/verify?user_code=WXYZ-1234",
        expires_in: 600,
        interval: 5,
      }),
    );

    try {
      await deviceFlow.login({ ...baseDeps, noWait: true });
      expect.fail("should have thrown SplitFlowSignal");
    } catch (e) {
      expect(e).toBeInstanceOf(SplitFlowSignal);
      const signal = e as SplitFlowSignal;
      expect(signal.deviceCode).toBe("dc_split");
      expect(signal.verificationUrl).toBe("http://test/verify?user_code=WXYZ-1234");
      expect(signal.userCode).toBe("WXYZ-1234");
      expect(signal.expiresIn).toBe(600);
      expect(signal.interval).toBe(5);
    }
  });
});

describe("device flow:--device-code split-flow(恢复轮询)", () => {
  it("直接用已有 device_code 轮询(不重新申请)", async () => {
    const mockPoller = vi.fn();
    mockPoller.mockResolvedValueOnce({
      status: "ok",
      token: { access_token: "AT_resume", expires_in: 3600, refresh_token: "RT", scope: "s" },
    });

    const token = await deviceFlow.login({
      ...baseDeps,
      poller: mockPoller,
      resumeDeviceCode: "dc_existing",
    });

    expect(token.access_token).toBe("AT_resume");
    // 不应该调 fetch(不申请新设备码)
    expect(fetchMock).not.toHaveBeenCalled();
    // 应该直接轮询已有的 device_code
    expect(mockPoller).toHaveBeenCalledWith(baseDeps.cfg, "dc_existing");
  });
});
