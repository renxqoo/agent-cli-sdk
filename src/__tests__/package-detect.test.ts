import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { detectBinName, detectBizPackage, detectVersion } from "../package-detect.js";

it("skips the SDK package when detecting the business CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-kit-detect-"));
  const originalArgv = process.argv;
  try {
    const sdkDir = join(root, "node_modules", "@myriosx", "cli-kit");
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@test/orders", bin: { orders: "index.js" }, version: "1.2.3" }),
    );
    writeFileSync(
      join(sdkDir, "package.json"),
      JSON.stringify({
        name: "@myriosx/cli-kit",
        bin: { sdk: "index.js" },
        version: "0.0.1",
      }),
    );
    const entry = join(sdkDir, "index.js");
    writeFileSync(entry, "");
    process.argv = [process.execPath, entry];

    expect(detectBinName()).toBe("orders");
    expect(detectVersion()).toBe("1.2.3");
    expect(detectBizPackage()).toEqual({ name: "@test/orders", bin: "orders", version: "1.2.3" });
  } finally {
    process.argv = originalArgv;
    rmSync(root, { recursive: true, force: true });
  }
});
