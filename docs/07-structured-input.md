# Command arguments: argv and JSON

`defineCommand` has one argument boundary and Zod is its only schema and type source. The SDK does
not wrap Zod and does not expose a second validator protocol.

```ts
args?:
  | { type?: "argv"; schema: ZodObject; pos?: string[] }
  | { type: "json"; schema: ZodObject; pos?: never };
```

- Omit `args`: the command accepts no business parameters and `run` receives `{}`.
- Omit `args.type`: it defaults to native `argv` mode.
- `args.pos` names schema fields consumed only as positional operands, in order. They are not also
  accepted as long flags. Other fields become kebab-case long flags.
- Set `args.type: "json"`: the entire arguments object comes from one JSON document. Positional
  operands and business flags are invalid in this mode.

Use the standard `zod` package directly. The SDK does not wrap Zod or maintain a separate Mini
contract.

## From no arguments to ordinary argv

```ts
import * as z from "zod";
import { defineCommand } from "@renxqoo/agent-cli-sdk";

export const health = defineCommand({
  name: "health",
  description: "Check service health",
  async run() {
    return { data: { healthy: true } };
  },
});

export const getOrder = defineCommand({
  name: "get",
  description: "Get an order",
  args: {
    schema: z.object({
      id: z.string().min(1).describe("Order ID"),
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

The shell performs quoting and expansion before the SDK sees `argv`. The SDK maps tokens to schema
fields and calls Zod. It preserves `--` as the standard end-of-options marker, repeated array flags,
`--flag` / `--no-flag` booleans, negative values, pipes, redirects, and shell exit semantics.

Use `z.coerce.number()` for numeric argv fields because shell arguments arrive as strings. Nested
objects are intentionally rejected in argv mode; use JSON mode instead.

## Complex JSON commands

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
  description: "Create an order",
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

Provide one complete document using exactly one transport:

```bash
orders create --input '{"customerId":"customer-1","items":[],"shippingAddress":{"country":"CN","city":"Shanghai","address":"Example Road 1"}}' --idempotency-key create-202 --yes
orders create --input-file ./order.json --idempotency-key create-202 --yes
orders create < ./order.json --idempotency-key create-202 --yes
generate-order | orders create --idempotency-key create-202 --yes
```

There is no `--input-stdin`: redirected or piped stdin is already the native shell interface. JSON
mode never merges `--customer-id ...` or positional operands into the document. Inline and file
sources are mutually exclusive. Prefer files or stdin for secrets because inline JSON may appear in
shell history and process listings.

Discovery uses the same Zod object:

```bash
orders create --input-schema | jq '.data.schema'
orders create --input-example | jq '.data.example'
```

JSON is byte-bounded, fatal UTF-8 decoded, and strictly parsed. Duplicate keys,
prototype-polluting keys, symbolic-link input files, unsafe integers, and excessive depth or size
are rejected before `run`.

## Write policy

`policy` describes execution safety, not business arguments. Its framework flags never enter the
Zod object passed to `run`.

```ts
policy: {
  mode: "write",
  dryRun: true,
  confirmation: "required",
  idempotency: "required",
  idempotencyHeader: "Idempotency-Key",
}
```

- `--dry-run` validates and redacts args but never calls `run`.
- `--yes` satisfies required confirmation.
- `--idempotency-key` is caller-owned, injected into requests, and should be reused for retries of
  the same operation.
- Schema metadata `sensitive` contains JSON Pointer paths used only for audit and preview redaction.

The backend remains authoritative for authorization, business rules, and idempotency persistence.

## Native shell composition

The SDK does not implement its own pipeline or workflow language. Successful data stays on stdout,
errors stay on stderr, and exit codes determine `&&` / `||` behavior.

```bash
# Filter one command's JSON envelope.
orders list --status paid --limit 100 | jq '.data[] | select(.total > 1000)'

# Feed a generated document to a JSON command.
jq -n --arg customer customer-1 \
  '{customerId:$customer,items:[],shippingAddress:{country:"CN",city:"Shanghai",address:"Example Road 1"}}' \
  | orders create --idempotency-key create-203 --yes

# Run the next command only after success; handle failure with normal shell control flow.
orders create --input-file order.json --idempotency-key create-204 --yes \
  && orders get order-204 \
  || printf '%s\n' 'order workflow failed' >&2

# Preserve output while also writing an audit artifact.
orders list --status pending | tee pending-orders.json | jq '.data | length'

# Invoke one native argv command per ID.
orders list --status pending \
  | jq -r '.data[].id' \
  | xargs -n1 orders get

# Combine independent command results using shell process substitution.
jq -s '{orders:.[0].data,invoices:.[1].data}' \
  <(orders list --limit 20) \
  <(invoices list --limit 20)
```

Quoting, variables, globbing, command substitution, redirection, pipes, `tee`, `jq`, `xargs`, `&&`,
`||`, and background jobs remain shell features. The SDK's responsibility ends at deterministic
argument mapping, Zod validation, policy enforcement, and stable stdout/stderr/exit behavior.
