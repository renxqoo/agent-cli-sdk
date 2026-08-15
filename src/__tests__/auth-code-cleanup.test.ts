import { beforeEach, describe, expect, it, vi } from "vitest";

const callback = vi.hoisted(() => ({
  close: vi.fn(),
  result: new Promise<never>(() => {}),
}));

vi.mock("../infra/callback-server.js", () => ({
  waitForCallback: vi.fn(async () => ({
    redirectUri: "http://127.0.0.1:9999/callback",
    result: callback.result,
    close: callback.close,
  })),
}));

import { authCodeFlow } from "../flows/authCode.js";

describe("authorization-code resource cleanup", () => {
  beforeEach(() => callback.close.mockClear());

  it("浏览器打开失败时关闭回调服务器", async () => {
    await expect(
      authCodeFlow.login({
        type: "authorization_code",
        cfg: { baseUrl: "https://auth.example", clientId: "id", clientSecret: "" },
        browser: { open: vi.fn().mockRejectedValue(new Error("browser unavailable")) },
      }),
    ).rejects.toThrow("browser unavailable");

    expect(callback.close).toHaveBeenCalledOnce();
  });
});
