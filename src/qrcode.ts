/**
 * @renxqoo/agent-cli-sdk —— qrcode 内置命令
 *
 * 迁自 v1 commands/qrcode.ts。
 * 把 URL 生成二维码(终端 ASCII 或 PNG 文件),服务 agent split-flow 登录场景。
 * URL 视为 opaque string,不做任何修改。
 *
 * 输出约定(对齐输出契约):
 *   - --output <path>:写 PNG 文件,stdout 返回统一输出 {ok, data:{output}}
 *   - 默认:ASCII 二维码打到 stderr(人看),stdout 返回统一输出 {ok, data:{ascii:true}}
 *     (ASCII 走 stderr 不污染 stdout;若走 stdout 会破坏管道且非结构化)
 */

import QRCode from "qrcode";
import * as z from "zod";
import type { CommandSpec } from "./types.js";
import { errs } from "./errs/index.js";

// 注意:不 import defineCommand(会和 define.ts 形成循环依赖)。
// 直接构造 CommandSpec 对象(defineCommand 只是 identity + 校验,这里手动保证 name/run)。
export const qrcodeCommand: CommandSpec<any, unknown> = {
  name: "qrcode",
  description: "Generate a QR code from a URL (terminal ASCII or PNG file)",
  skipPluginHooks: true,
  args: {
    schema: z.object({
      url: z.string().describe("URL to encode (opaque string, do not modify)"),
      output: z.string().describe("Output PNG to the specified file path").optional(),
      ascii: z
        .boolean()
        .describe("Print ASCII QR code to terminal (default behavior)")
        .default(false),
    }),
    pos: ["url"],
  },
  async run(ctx, args) {
    const url = args.url;
    if (args.output) {
      try {
        await QRCode.toFile(args.output, url, { type: "png" });
        ctx.log.info(`QR code PNG generated: ${args.output}`);
        return { data: { output: args.output } };
      } catch (e) {
        throw new errs.InternalError({
          subtype: "unknown",
          message: `Failed to generate QR code: ${e instanceof Error ? e.message : e}`,
        });
      }
    }
    // 默认(含显式 --ascii):终端 ASCII 打到 stderr(不污染 stdout)
    try {
      const ascii = await QRCode.toString(url, { type: "terminal", small: true });
      process.stderr.write(ascii + "\n");
      return { data: { ascii: true } };
    } catch (e) {
      throw new errs.InternalError({
        subtype: "unknown",
        message: `Failed to generate QR code: ${e instanceof Error ? e.message : e}`,
      });
    }
  },
};
