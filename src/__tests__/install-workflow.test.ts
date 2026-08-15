import { describe, expect, it, vi } from "vitest";
import { InstallWorkflow, type InstallPresenter, type InstallSystem } from "../install-workflow.js";

function harness(overrides: Partial<InstallSystem> = {}) {
  const events: string[] = [];
  const system: InstallSystem = {
    globallyInstalledVersion: vi.fn(async () => null),
    latestVersion: vi.fn(async () => "2.0.0"),
    installGlobally: vi.fn(async (name) => events.push(`install:${name}`)),
    installSkillsFrom: vi.fn(async (source) => events.push(`source:${source}`)),
    findBinary: vi.fn(async () => "/bin/rxcli"),
    syncSkills: vi.fn(async () => events.push("sync")),
    isRegistered: vi.fn(async () => false),
    register: vi.fn(async () => events.push("register")),
    login: vi.fn(async () => events.push("login")),
    ...overrides,
  };
  const presenter: InstallPresenter = {
    chooseLanguage: vi.fn(async () => "en"),
    confirmLogin: vi.fn(async () => true),
    intro: (message) => events.push(`intro:${message}`),
    outro: (message) => events.push(`outro:${message}`),
    start: (message) => events.push(`start:${message}`),
    update: (message) => events.push(`update:${message}`),
    succeed: (message) => events.push(`success:${message}`),
    fail: (message) => events.push(`fail:${message}`),
    info: (message) => events.push(`info:${message}`),
    warn: (message) => events.push(`warn:${message}`),
    cancel: (message) => events.push(`cancel:${message}`),
  };
  return { workflow: new InstallWorkflow(system, presenter), system, presenter, events };
}

describe("InstallWorkflow boundary", () => {
  it("owns the complete interactive install sequence", async () => {
    const { workflow, events } = harness();

    await expect(
      workflow.run({ package: { name: "@acme/cli", bin: "acme" }, interactive: true }),
    ).resolves.toBe(0);

    expect(
      events.filter((event) => ["install:@acme/cli", "sync", "register", "login"].includes(event)),
    ).toEqual(["install:@acme/cli", "sync", "register", "login"]);
    expect(events.at(-1)).toMatch(/^outro:/);
  });

  it("uses the remote skill source and does not run local sync", async () => {
    const { workflow, system, events } = harness();
    await workflow.run({
      package: { name: "@acme/cli", bin: "acme" },
      skillsSource: "https://example.test/skills",
      interactive: false,
      language: "en",
    });
    expect(events).toContain("source:https://example.test/skills");
    expect(system.syncSkills).not.toHaveBeenCalled();
    expect(system.register).not.toHaveBeenCalled();
  });

  it("falls back to local sync when remote skill installation fails", async () => {
    const { workflow, events } = harness({
      installSkillsFrom: vi.fn(async () => {
        throw new Error("registry unavailable");
      }),
    });
    await expect(
      workflow.run({
        package: { name: "@acme/cli", bin: "acme" },
        skillsSource: "https://example.test/skills",
        interactive: false,
      }),
    ).resolves.toBe(0);
    expect(events).toContain("sync");
    expect(events.some((event) => event.startsWith("update:"))).toBe(true);
  });

  it("stops after a required step fails", async () => {
    const { workflow, system } = harness({
      installGlobally: vi.fn(async () => {
        throw new Error("permission denied");
      }),
    });
    await expect(
      workflow.run({
        package: { name: "@acme/cli", bin: "acme" },
        interactive: true,
        language: "en",
      }),
    ).resolves.toBe(1);
    expect(system.syncSkills).not.toHaveBeenCalled();
    expect(system.register).not.toHaveBeenCalled();
  });

  it("treats login as recoverable after installation and registration", async () => {
    const { workflow, events } = harness({
      login: vi.fn(async () => {
        throw new Error("browser closed");
      }),
    });
    await expect(
      workflow.run({
        package: { name: "@acme/cli", bin: "acme" },
        interactive: true,
        language: "en",
      }),
    ).resolves.toBe(0);
    expect(events.some((event) => event.startsWith("warn:"))).toBe(true);
    expect(events.at(-1)).toMatch(/^outro:/);
  });
});
