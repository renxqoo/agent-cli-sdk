import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "errs/index": "src/errs/index.ts",
    "credentials/index": "src/credentials/index.ts",
    "skills/index": "src/skills/index.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: true,
  minify: true,
  sourcemap: false,
  dts: true,
  clean: true,
  treeshake: true,
  outDir: "dist",
});
