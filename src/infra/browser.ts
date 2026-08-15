/**
 * 浏览器打开抽象(authorization_code flow 用)。
 *
 * 平台相关:macOS=open, Linux=xdg-open, Windows=FileProtocolHandler。
 * 通过 BrowserOpener 接口抽象,测试可 mock。
 */
import { execFile } from "node:child_process";
import { platform } from "node:os";

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

export interface BrowserLaunchCommand {
  executable: string;
  args: string[];
}

/** Build a shell-free launch command for the target platform. */
export function browserLaunchCommand(os: NodeJS.Platform, url: string): BrowserLaunchCommand {
  if (os === "darwin") return { executable: "open", args: [url] };
  if (os === "win32") {
    return { executable: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { executable: "xdg-open", args: [url] };
}

/**
 * 默认浏览器打开器:按平台选命令。
 * macOS → open, Linux → xdg-open, Windows → rundll32 FileProtocolHandler。
 */
export function defaultBrowserOpener(): BrowserOpener {
  return {
    async open(url: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const command = browserLaunchCommand(platform(), url);
        execFile(command.executable, command.args, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
