import { defineCli, type CommandContext, type RequestControls } from "../src/index.js";
import { createContext, setupPlugins } from "../src/advanced.js";
// @ts-expect-error Runtime dispatch is available through the advanced entry point only.
import { runCommand } from "../src/index.js";
// @ts-expect-error Skill generation utilities belong to the skills entry point.
import { generateAutogenBlock } from "../src/index.js";

declare const ctx: CommandContext;
const controls: RequestControls = { timeout: 500, signal: new AbortController().signal };
void ctx.get<{ id: string }>("/items", { limit: 1 }, controls);
void ctx.post("/items", { id: "1" }, controls);
void ctx.put("/items/1", {}, controls);
void ctx.patch("/items/1", {}, controls);
void ctx.delete("/items/1", controls);
void ctx.request({ method: "GET", path: "/items", ...controls, allowHttpErrors: true });
// @ts-expect-error Arbitrary objects cannot substitute for an AbortSignal.
void ctx.get("/items", undefined, { signal: {} });
// @ts-expect-error Timeouts are expressed in numeric milliseconds.
void ctx.post("/items", {}, { timeout: "500" });
defineCli({
  name: "typed-request",
  description: "request fixture",
  requestTimeoutMs: 500,
  commands: {},
});
void [createContext, setupPlugins, runCommand, generateAutogenBlock];
