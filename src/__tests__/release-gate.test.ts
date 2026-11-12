import { describe, expect, it } from "vitest";
// The actual release script is the policy under test, not a parallel test implementation.
import { validateRelease } from "../../scripts/check-release.mjs";

const previous = { name: "@test/sdk", version: "1.0.1" };
const current = { ...previous, version: "2.0.0" };
const entry = "## [@test/sdk@2.0.0] - 2026-11-12\n\n### Changed\n\n- Migration.\n";

describe("release metadata gate", () => {
  it("accepts the release and allows follow-up changes without a version bump", () => {
    expect(() => validateRelease(current, previous, entry)).not.toThrow();
    expect(() => validateRelease(current, current, entry)).not.toThrow();
  });
  it.each(["", "## [@test/sdk@1.0.1] - 2026-11-12", entry + entry])(
    "rejects missing, stale or duplicate release entries",
    (text) => {
      expect(() => validateRelease(current, previous, text)).toThrow(
        "exactly one changelog heading",
      );
    },
  );
  it.each(["1.0", "01.0.0", "1.0.0", "1.0.1+build.2", "1.0.1-01", "2.0.0-"])(
    "rejects invalid or non-increasing release %s",
    (version) => {
      expect(() => validateRelease({ ...current, version }, previous, entry)).toThrow();
    },
  );
  it.each(["2026-02-30", "2026-13-01", "2026-1-2"])("rejects invalid release date %s", (date) => {
    expect(() => validateRelease(current, previous, entry.replace("2026-11-12", date))).toThrow(
      "release date",
    );
  });
  it("orders numeric prerelease identifiers and promotes prereleases to stable", () => {
    const candidate = { ...current, version: "2.0.0-rc.10" };
    expect(() =>
      validateRelease(
        candidate,
        { ...current, version: "2.0.0-rc.2" },
        entry.replace("2.0.0", candidate.version),
      ),
    ).not.toThrow();
    expect(() => validateRelease(current, candidate, entry)).not.toThrow();
  });
});
