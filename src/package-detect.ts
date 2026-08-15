/**
 * 业务包探测:从实际运行入口(process.argv[1])往上找 package.json,
 * 读取业务包的 name / bin / version。
 *
 * 从 define.ts 抽出(define.ts 职责过多,探测逻辑与命令定义/App 装配无关)。
 * 跳过 agent-cli-sdk 自己(@renxqoo/agent-cli-sdk)与 monorepo 根,避免版本串读。
 */
import { existsSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 取入口脚本路径(realpath 解软链)。npm 全局安装时 process.argv[1] 是 bin 软链,
 * realpath 后才是真实文件路径(detectBinName/detectVersion/detectBizPackage 往上找 package.json 用)。
 */
export function entryPath(): string | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
}

/**
 * 自动探测 bin 名:从实际运行的入口往上找 package.json,读 bin 第一个 key。
 * 业务包的 dist/index.js 是入口,其 package.json 在包根目录(往上找能命中)。
 * 找不到(bun compile / 测试 / 无 bin)返回 undefined,调用方回退到 name。
 */
export function detectBinName(): string | undefined {
  try {
    const entry = entryPath();
    if (!entry) return undefined;
    let dir = dirname(entry);
    for (let i = 0; i < 10; i++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string;
          bin?: string | Record<string, string>;
        };
        // 跳过 agent-cli-sdk 自己 / monorepo 根(无 bin 或 bin 不是业务命令)
        if (pkg.name === "@renxqoo/agent-cli-sdk" || !pkg.bin) {
          dir = dirname(dir);
          continue;
        }
        // M6: bin 是字符串但无 name 时无法确定 bin 名,继续上溯(与 detectBizPackage 一致)。
        const binName = typeof pkg.bin === "string" ? pkg.name : Object.keys(pkg.bin)[0];
        if (!pkg.name || !binName) {
          dir = dirname(dir);
          continue;
        }
        return binName;
      }
      dir = dirname(dir);
    }
  } catch {
    /* 找不到就回退 name */
  }
  return undefined;
}

/**
 * 探测业务包版本:从入口 package.json 读 version。
 * 找不到回退 "0.0.0"。测试/无入口场景用兜底值。
 */
export function detectVersion(): string {
  try {
    const entry = entryPath();
    if (entry) {
      let dir = dirname(entry);
      for (let i = 0; i < 10; i++) {
        const pkgPath = join(dir, "package.json");
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            name?: string;
            version?: string;
          };
          // 跳过 agent-cli-sdk 自己 / monorepo 根(agent-cli-sdk 版本 ≠ 业务包版本)
          if (pkg.name === "@renxqoo/agent-cli-sdk" || !pkg.version) {
            dir = dirname(dir);
            continue;
          }
          return pkg.version;
        }
        dir = dirname(dir);
      }
    }
  } catch {
    /* 找不到就回退兜底 */
  }
  return "0.0.0";
}

export interface BizPackageInfo {
  name: string;
  bin: string;
  version: string;
}

/**
 * 探测当前业务包的 { name, bin, version }(install 向导用)。
 * 从 process.argv[1](实际入口)往上找 package.json,跳过 agent-cli-sdk 自己 / monorepo 根。
 */
export function detectBizPackage(): BizPackageInfo | null {
  try {
    const entry = entryPath();
    if (!entry) return null;
    let dir = dirname(entry);
    for (let i = 0; i < 10; i++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string;
          version?: string;
          bin?: string | Record<string, string>;
        };
        // 跳过 agent-cli-sdk 自己 / monorepo 根(无 bin 或不是业务命令)
        if (pkg.name === "@renxqoo/agent-cli-sdk" || !pkg.bin) {
          dir = dirname(dir);
          continue;
        }
        const binName = typeof pkg.bin === "string" ? pkg.name : Object.keys(pkg.bin)[0];
        if (!pkg.name || !binName) {
          dir = dirname(dir);
          continue;
        }
        return { name: pkg.name, bin: binName, version: pkg.version ?? "0.0.0" };
      }
      dir = dirname(dir);
    }
  } catch {
    /* 找不到就返回 null,向导回退 */
  }
  return null;
}
