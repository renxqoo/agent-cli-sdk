import { describe, expect, it } from "vitest";
import { defaultBrowserOpener } from "../infra/browser.js";

describe("browser opener", () => {
  it("exposes an asynchronous open boundary", () => {
    expect(defaultBrowserOpener().open).toBeTypeOf("function");
  });
});
