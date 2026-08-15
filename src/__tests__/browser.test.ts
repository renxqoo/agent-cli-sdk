import { describe, expect, it } from "vitest";
import { browserLaunchCommand } from "../infra/browser.js";

describe("browser launch command", () => {
  it("uses FileProtocolHandler on Windows without command-shell parsing", () => {
    expect(browserLaunchCommand("win32", "https://example.com/a?b=1")).toEqual({
      executable: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "https://example.com/a?b=1"],
    });
  });

  it("uses native launchers without a shell on macOS and Linux", () => {
    expect(browserLaunchCommand("darwin", "https://example.com")).toEqual({
      executable: "open",
      args: ["https://example.com"],
    });
    expect(browserLaunchCommand("linux", "https://example.com")).toEqual({
      executable: "xdg-open",
      args: ["https://example.com"],
    });
  });
});
