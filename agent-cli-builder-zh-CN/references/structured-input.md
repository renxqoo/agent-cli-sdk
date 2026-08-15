# JSON 参数与写操作安全

创建、更新、批量或嵌套请求如果需要很多容易出错的 flags，使用 JSON 模式。命令仍然只有
一个 `args` 属性，Zod 是唯一 schema 和类型来源。

```ts
import * as z from "zod";
import { defineCommand } from "@renxqoo/agent-cli-sdk";

const CreateOrder = z
  .strictObject({
    customerId: z.string(),
    items: z.array(
      z.strictObject({
        sku: z.string(),
        quantity: z.number().int().positive(),
      }),
    ),
    address: z.strictObject({ country: z.string(), city: z.string(), line1: z.string() }),
    remark: z.string().optional(),
  })
  .register(z.globalRegistry, {
    sensitive: ["/remark"],
    examples: [{ customerId: "c1", items: [], address: { country: "CN", city: "上海", line1: "示例路 1 号" } }],
  });

export const create = defineCommand({
  name: "create",
  description: "创建订单",
  args: { type: "json", schema: CreateOrder },
  policy: {
    mode: "write",
    dryRun: true,
    confirmation: "required",
    idempotency: "required",
  },
  async run(ctx, args) {
    return { data: (await ctx.post("/orders", args)).data };
  },
});
```

禁止增加 `zodInput`、validator adapter、Standard Schema、并行 `input` 契约或手写 Args
类型。`run(ctx, args)` 中 `args` 的类型就是 Zod output。

## 原生调用契约

必须提供一个完整 JSON 文档：

```bash
my-cli create --input '{"customerId":"c1","items":[],"address":{"country":"CN","city":"上海","line1":"示例路1号"}}' --idempotency-key create-1 --yes
my-cli create --input-file ./order.json --idempotency-key create-1 --yes
my-cli create < ./order.json --idempotency-key create-1 --yes
generate-order | my-cli create --idempotency-key create-1 --yes
```

不存在 `--input-stdin`；重定向或管道就是 Shell 原生 stdin。`--input` 与 `--input-file`
互斥。JSON 模式不接受业务 flags 或位置参数，因此不会发生部分合并。敏感值优先使用文件
或 stdin。

```bash
my-cli create --input-schema | jq '.data.schema'
my-cli create --input-example | jq '.data.example'
```

## 可信性保证与 policy

运行时限制字节数、拒绝软链接文件、严格解码 UTF-8 和 JSON、拒绝重复键、原型污染键及
不安全整数，最后由 Zod 校验；错误不会回显原始文档。

`policy` 与业务 args 分离：

- `--dry-run` 校验并脱敏 args，使用只读预览上下文，且不会调用 `run`。
- `--yes` 满足强制确认。
- `--idempotency-key` 由调用方生成、注入请求，并在同一操作重试时复用；禁止根据载荷派生。
- Zod 根 metadata 的 `sensitive` 使用 JSON Pointer 路径，供观察器和预览脱敏。

## 保留 Shell 能力

不要创建工作流 DSL。引号、变量、管道、重定向、`jq`、`tee`、`xargs`、`&&` 和 `||`
继续由 Shell 负责：

```bash
jq -n '{customerId:"c1",items:[],address:{country:"CN",city:"上海",line1:"示例路1号"}}' \
  | my-cli create --idempotency-key create-2 --yes \
  && my-cli get order-2

my-cli list --status pending | jq -r '.data[].id' | xargs -n1 my-cli get
my-cli list | tee orders.json | jq '.data | length'
```

SDK 只负责确定性映射、校验、policy、stdout/stderr 分离和退出码；Shell 负责编排。
