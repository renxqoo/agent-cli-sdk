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
  it("accepts a renamed package starting at 0.0.1 and subsequent unchanged releases", () => {
    const initial = { name: "@myriosx/cli-kit", version: "0.0.1" };
    const initialEntry = "## [@myriosx/cli-kit@0.0.1] - 2026-11-12\n";
    expect(() => validateRelease(initial, current, initialEntry)).not.toThrow();
    expect(() => validateRelease(initial, initial, initialEntry)).not.toThrow();
    expect(() => validateRelease(initial, current, entry)).toThrow("exactly one changelog heading");
  });
  it.each(["0.0.0", "0.0.1-rc.1", "0.0.1+build.1", "1.0.0", "3.0.0"])(
    "rejects package renames without an initial 0.0.1 release: %s",
    (version) => {
      expect(() => validateRelease({ name: "@test/renamed-sdk", version }, current, entry)).toThrow(
        "Package renames must start at version 0.0.1",
      );
    },
  );
  it("rejects resetting an existing package to 0.0.1", () => {
    expect(() => validateRelease({ ...current, version: "0.0.1" }, current, entry)).toThrow(
      "Package version must increase",
    );
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
