# 命令参数：argv 与 JSON

`defineCommand` 只有一个参数边界，Zod 是其唯一的 schema 与类型来源。SDK 不包装 Zod，也不暴露第二种校验协议。

```ts
args?:
  | { type?: "argv"; schema: ZodObject; pos?: string[] }
  | { type: "json"; schema: ZodObject; pos?: never };
```

- 省略 `args`：该命令不接受业务参数，`run` 收到 `{}`。
- 省略 `args.type`：默认使用原生 `argv` 模式。
- `args.pos` 按顺序命名仅作为位置操作数消费的 schema 字段。它们不会再被接受为长选项标志。其他字段会成为 kebab-case 形式的长选项标志。
- 设置 `args.type: "json"`：整个参数对象来自一份 JSON 文档。此模式下位置操作数与业务标志无效。

直接使用标准的 `zod` 包。SDK 不包装 Zod，也不维护独立的 Mini 契约。

## 从无参数到普通 argv

```ts
import * as z from "zod";
import { defineCommand } from "@renxqoo/agent-cli-sdk";

export const health = defineCommand({
  name: "health",
  description: "检查服务健康",
  async run() {
    return { data: { healthy: true } };
  },
});

export const getOrder = defineCommand({
  name: "get",
  description: "获取订单",
  args: {
    schema: z.object({
      id: z.string().min(1).describe("订单 ID"),
      format: z.enum(["summary", "detail"]).default("summary"),
      includeItems: z.boolean().default(false),
      tag: z.array(z.string()).default([]),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }),
    pos: ["id", "format"],
  },
  async run(ctx, args) {
    const response = await ctx.get(`/orders/${args.id}`, args);
    return { data: response.data };
  },
});
```

```bash
orders health
orders get order-1
orders get order-1 detail --include-items --tag vip --tag urgent --limit 50
orders get -- --id-that-starts-with-dashes
```

shell 在 SDK 看到 `argv` 之前完成引号处理与展开。SDK 将 token 映射到 schema 字段并调用 Zod。它保留 `--` 作为标准的选项结束标记、可重复的数组标志、`--flag` / `--no-flag` 布尔值、负数值、管道、重定向以及 shell 退出语义。

对数值型 argv 字段使用 `z.coerce.number()`，因为 shell 参数是以字符串形式到达的。argv 模式下有意拒绝嵌套对象；请改用 JSON 模式。

## 复杂 JSON 命令

```ts
const CreateOrder = z
  .strictObject({
    customerId: z.string().min(1),
    items: z.array(
      z.strictObject({
        sku: z.string(),
        quantity: z.number().int().positive(),
        attributes: z.record(z.string(), z.string()).optional(),
      }),
    ),
    shippingAddress: z.strictObject({
      country: z.string(),
      city: z.string(),
      address: z.string(),
    }),
    remark: z.string().optional(),
  })
  .register(z.globalRegistry, {
    sensitive: ["/remark"],
    examples: [
      {
        customerId: "customer-1",
        items: [{ sku: "sku-1", quantity: 2 }],
        shippingAddress: { country: "CN", city: "Shanghai", address: "Example Road 1" },
      },
    ],
  });

export const createOrder = defineCommand({
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
    const response = await ctx.post("/orders", args);
    return { data: response.data };
  },
});
```

使用恰好一种传输方式提供一份完整文档：

```bash
orders create --input '{"customerId":"customer-1","items":[],"shippingAddress":{"country":"CN","city":"Shanghai","address":"Example Road 1"}}' --idempotency-key create-202 --yes
orders create --input-file ./order.json --idempotency-key create-202 --yes
orders create < ./order.json --idempotency-key create-202 --yes
generate-order | orders create --idempotency-key create-202 --yes
```

不存在 `--input-stdin`：重定向或管道传入的 stdin 本身就是原生的 shell 接口。JSON 模式绝不会把 `--customer-id ...` 或位置操作数合并进文档。内联与文件来源互斥。对于机密信息，优先使用文件或 stdin，因为内联 JSON 可能出现在 shell 历史与进程列表中。

发现（discovery）使用同一个 Zod 对象：

```bash
orders create --input-schema | jq '.data.schema'
orders create --input-example | jq '.data.example'
```

JSON 受字节上限约束、以致命错误方式做 UTF-8 解码，并严格解析。重复键、原型污染键、符号链接输入文件、不安全整数以及过深的嵌套或过大的体积都会在 `run` 之前被拒绝。

## 写入策略

`policy` 描述的是执行安全性，而非业务参数。它的框架标志绝不会进入传给 `run` 的 Zod 对象。

```ts
policy: {
  mode: "write",
  dryRun: true,
  confirmation: "required",
  idempotency: "required",
  idempotencyHeader: "Idempotency-Key",
}
```

- `--dry-run` 会校验并脱敏 args，但绝不调用 `run`。
- `--yes` 满足必需的确认要求。
- `--idempotency-key` 由调用方持有，注入到请求中，对同一操作的重试应复用它。
- Schema 元数据 `sensitive` 包含 JSON Pointer 路径，仅用于审计与预览脱敏。

后端仍然是授权、业务规则与幂等持久化的权威来源。

## 原生 shell 组合

SDK 不实现自己的管道或工作流语言。成功数据保留在 stdout，错误保留在 stderr，退出码决定 `&&` / `||` 的行为。

```bash
# 过滤某个命令的 JSON 统一输出格式。
orders list --status paid --limit 100 | jq '.data[] | select(.total > 1000)'

# 将生成的文档喂给某个 JSON 命令。
jq -n --arg customer customer-1 \
  '{customerId:$customer,items:[],shippingAddress:{country:"CN",city:"Shanghai",address:"Example Road 1"}}' \
  | orders create --idempotency-key create-203 --yes

# 仅在成功后运行下一条命令；用常规的 shell 控制流处理失败。
orders create --input-file order.json --idempotency-key create-204 --yes \
  && orders get order-204 \
  || printf '%s\n' '订单工作流失败' >&2

# 在写出审计产物的同时保留输出。
orders list --status pending | tee pending-orders.json | jq '.data | length'

# 为每个 ID 调用一次原生 argv 命令。
orders list --status pending \
  | jq -r '.data[].id' \
  | xargs -n1 orders get

# 使用 shell 进程替换组合相互独立的命令结果。
jq -s '{orders:.[0].data,invoices:.[1].data}' \
  <(orders list --limit 20) \
  <(invoices list --limit 20)
```

引号处理、变量、通配符（globbing）、命令替换、重定向、管道、`tee`、`jq`、`xargs`、`&&`、`||` 以及后台任务都仍是 shell 的特性。SDK 的职责止于确定性的参数映射、Zod 校验、策略执行以及稳定的 stdout/stderr/退出码行为。
