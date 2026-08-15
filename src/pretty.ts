/**
 * @renxqoo/agent-cli-sdk --no-json 模式的通用文本渲染(给人看)
 *
 * agent-native 默认 JSON 统一输出(--json / 不传);--no-json 时切到人类可读文本,
 * 用通用兜底 prettyPrint(命令可选 humanFormat 覆盖)。错误也文本化(prettyError)。
 *
 * prettyPrint 兜底策略(结构识别,不猜业务语义):
 *   - 数组 / { key: 数组 } 单 key 包装 → 自动表格(对象项)/ 序号列表(scalar 项)
 *   - 单对象 → key: value 详情
 *   - null/scalar → 直接输出
 * 想要精致(¥/中文列名/隐藏列)→ 命令声明 humanFormat 覆盖。
 */

import type { Meta } from "./types.js";
import type { CliError } from "./errs/index.js";

// ============================================================================
// 成功:通用兜底 prettyPrint(data, meta)
// ============================================================================

/**
 * 把 data + meta 渲染成人类可读文本(--no-json 模式的通用兜底)。
 * 命令可选声明 spec.humanFormat 覆盖;不声明就用这个。
 *
 * 规则(结构识别,不猜业务语义):
 *   - null/undefined → "（无数据）"
 *   - scalar(string/number/boolean) → 直接 String()
 *   - 数组 / { key: 数组 } → 自动表格(对象项)/ 序号列表(scalar 项)
 *   - 单对象 → key: value 详情(每行一个字段)
 *   - meta 有 count/pagination → 末尾附摘要行
 */
export function prettyPrint(data: unknown, meta?: Meta): string {
  const lines: string[] = [];

  if (data === null || data === undefined) {
    lines.push("(no data)");
  } else if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") {
    lines.push(String(data));
  } else {
    // 结构化数据:尝试提取数组(直接数组 或 { key: 数组 } 单 key 包装)
    const arr = extractArray(data);
    if (arr) {
      lines.push(renderArray(arr));
    } else if (typeof data === "object") {
      // 单对象 → key: value 详情
      lines.push(formatObject(data as Record<string, unknown>));
    } else {
      lines.push(String(data));
    }
  }

  // meta 摘要(count / pagination)
  if (meta) {
    const summary: string[] = [];
    if (meta.count !== undefined) summary.push(`${meta.count} item(s)`);
    if (meta.pagination) {
      const p = meta.pagination;
      summary.push(p.complete ? "all loaded" : `more: ${p.nextToken ?? "?"}`);
      if (p.pages !== undefined) summary.push(`${p.pages} page(s)`);
    }
    if (summary.length > 0) {
      lines.push("");
      lines.push(`(${summary.join(" · ")})`);
    }
  }

  return lines.join("\n");
}

/**
 * 从 data 提取数组:
 *   - data 本身是数组 → 返回
 *   - data 是 { key: 数组 } 单 key 包装(如 { orders: [...] })→ 返回那个数组
 *   - data 是含数组字段但还有其他字段的对象(如 { name:'x', items:[...] })→ 返回 null
 *     (多字段对象是详情视图,不应被当列表;否则会丢掉非数组字段)
 *   - 否则 → null(不是数组形态)
 */
function extractArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    // 只有"恰好一个 key 且该 key 是数组"才当列表包装;多字段对象走详情视图
    if (entries.length === 1 && Array.isArray(entries[0]![1])) {
      return entries[0]![1] as unknown[];
    }
  }
  return null;
}

/**
 * 渲染数组:对象项 → 自动表格(printTable,取首个对象的 keys 当列);
 * scalar 项 → 序号列表。
 */
function renderArray(arr: unknown[]): string {
  if (arr.length === 0) return "(empty)";
  // 对象项 → 自动表格
  if (arr.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
    const records = arr as Record<string, unknown>[];
    // 取所有对象 keys 的并集(保持出现顺序),作为列
    const keys: string[] = [];
    for (const rec of records) {
      for (const k of Object.keys(rec)) {
        if (!keys.includes(k)) keys.push(k);
      }
    }
    const columns = keys.map((k) => ({
      header: k,
      value: (row: Record<string, unknown>) => formatScalar(row[k]),
      // 数值列右对齐(所有值都是 number)
      align: records.every((r) => typeof r[k] === "number")
        ? ("right" as const)
        : ("left" as const),
    }));
    return printTable(records, columns);
  }
  // scalar 项 → 序号列表
  return arr.map((item, i) => `${i + 1}. ${formatScalar(item)}`).join("\n");
}

/**
 * 格式化单对象为 key: value 详情(每行一个字段)。
 * 嵌套对象/数组用缩进 JSON。
 */
function formatObject(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}:  ${formatScalar(v)}`)
    .join("\n");
}

/**
 * 格式化单个值为可读字符串:scalar 直接 String;对象/数组用紧凑 JSON。
 */
function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ============================================================================
// 表格渲染(printTable)—— 命令 humanFormat 用,通用列对齐工具
// ============================================================================

export interface TableColumn<T> {
  /** 列标题。 */
  header: string;
  /** 从行数据取值(返回 string/number 等,自动 String())。 */
  value: (row: T) => unknown;
  /** 可选:自定义对齐(默认左对齐;数值类可设 'right')。 */
  align?: "left" | "right";
}

/**
 * 字符串的终端显示宽度(CJK 全角字符算 2 列,其余 1 列)。
 * 用 String.length 会把中文算 1 列导致表格错位(终端实际占 2 列)。
 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    // CJK 统一表意文字 + 全角标点区间(常见中日韩)按 2 列
    const code = ch.codePointAt(0) ?? 0;
    w +=
      code > 0x1100 &&
      ((code >= 0x2e80 && code <= 0x9fff) || // CJK 部首/文字
        (code >= 0xac00 && code <= 0xd7af) || // 韩文音节
        (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容
        (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII/标点
        (code >= 0xffe0 && code <= 0xffe6)) // 全角符号(¥ 等)
        ? 2
        : 1;
  }
  return w;
}

/** 按显示宽度填充右侧(左对齐用):补空格到目标显示宽度。 */
function padEndDisplay(s: string, width: number): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

/** 按显示宽度填充左侧(右对齐用):补空格到目标显示宽度。 */
function padStartDisplay(s: string, width: number): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? " ".repeat(pad) + s : s;
}

/**
 * 渲染数组为对齐表格(--no-json 模式命令 humanFormat 用)。
 *
 * ```ts
 * humanFormat: (data) => printTable((data as {orders:Order[]}).orders, [
 *   { header: 'ID', value: r => r.id },
 *   { header: '总额', value: r => `¥${r.total}`, align: 'right' },
 *   { header: '状态', value: r => statusZh(r.status) },
 * ])
 * ```
 *
 * @param rows 行数据数组(空数组 → "（空）")
 * @param columns 列定义(标题 + 取值 + 对齐)
 * @returns 多行文本(标题行 + 分隔行 + 数据行)
 */
export function printTable<T>(rows: T[], columns: TableColumn<T>[]): string {
  if (rows.length === 0) return "(empty)";
  // 计算每列最大显示宽度(标题 vs 数据;CJK 按 2 列)
  const widths = columns.map((col) => {
    const dataMax = Math.max(...rows.map((r) => displayWidth(String(col.value(r) ?? ""))));
    return Math.max(displayWidth(col.header), dataMax);
  });
  // 渲染单元格(按对齐 + 显示宽度填充)
  const fmtCell = (text: string, width: number, align: "left" | "right" | undefined) =>
    align === "right" ? padStartDisplay(text, width) : padEndDisplay(text, width);
  // 标题行
  const headerLine = columns.map((c, i) => fmtCell(c.header, widths[i]!, c.align)).join("  ");
  // 分隔行(对齐宽度,分隔符不区分全半角,按列宽填 -)
  const sepLine = widths.map((w) => "-".repeat(w)).join("  ");
  // 数据行
  const dataLines = rows.map((r) =>
    columns.map((c, i) => fmtCell(String(c.value(r) ?? ""), widths[i]!, c.align)).join("  "),
  );
  return [headerLine, sepLine, ...dataLines].join("\n");
}

// ============================================================================
// 错误:prettyError(err)
// ============================================================================

/**
 * 把错误渲染成人类可读文本(--no-json 模式的 stderr 输出)。
 * 形态:`error: <message>` + 可选 `hint: <hint>` + 可选 `（type/subtype）`。
 */
export function prettyError(err: CliError): string {
  const lines: string[] = [];
  lines.push(`error: ${err.message}`);
  if (err.hint) lines.push(`hint: ${err.hint}`);
  // type/subtype 放括号里(诊断用,不喧宾夺主)
  lines.push(`（${err.category}/${err.subtype}${err.code !== undefined ? ` ${err.code}` : ""}）`);
  return lines.join("\n");
}
