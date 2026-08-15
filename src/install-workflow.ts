/**
 * Installation use-case. This module owns policy and sequencing; operating-system
 * access and terminal presentation are supplied by an adapter.
 */

export type InstallLanguage = "zh" | "en";

export interface InstallPackage {
  name: string;
  bin: string;
}

export interface InstallWorkflowOptions {
  package: InstallPackage;
  skillsSource?: string;
  interactive: boolean;
  language?: InstallLanguage;
  /**
   * Whether the CLI has an auth flow (register + login steps). Defaults to true.
   * Set false for open-data CLIs without auth — the wizard then stops after skills.
   */
  auth?: boolean;
}

export interface InstallSystem {
  globallyInstalledVersion(packageName: string): Promise<string | null>;
  latestVersion(packageName: string): Promise<string | null>;
  installGlobally(packageName: string): Promise<void>;
  installSkillsFrom(source: string): Promise<void>;
  findBinary(binName: string): Promise<string | null>;
  syncSkills(binary: string): Promise<void>;
  isRegistered(): Promise<boolean>;
  register(binary: string): Promise<void>;
  login(binary: string): Promise<void>;
}

export interface InstallPresenter {
  chooseLanguage(): Promise<InstallLanguage | null>;
  confirmLogin(message: string): Promise<boolean | null>;
  intro(message: string): void;
  outro(message: string): void;
  start(message: string): void;
  update(message: string): void;
  succeed(message: string): void;
  fail(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  cancel(message: string): void;
}

interface Messages {
  setup: string;
  step1: string;
  step1Upgrade: string;
  step1Skip: string;
  step1Done: string;
  step1Upgraded: string;
  step1Fail: string;
  step2Spinner: string;
  step2Done: string;
  step2FailNpx: string;
  step2FailAll: string;
  step3: string;
  step3Skip: string;
  step3Done: string;
  step3Fail: string;
  step4: string;
  step4NotFound: string;
  step4Confirm: string;
  step4Skip: string;
  step4Done: string;
  step4Fail: string;
  done: string;
  cancelled: string;
  nonTtyHint: string;
}

const messages: Record<InstallLanguage, Messages> = {
  zh: {
    setup: "正在设置 rxcli...",
    step1: "正在全局安装 %s...",
    step1Upgrade: "正在升级 %s (v%s → v%s)...",
    step1Skip: "已安装 (v%s),跳过",
    step1Done: "已全局安装",
    step1Upgraded: "已升级到 v%s",
    step1Fail: "全局安装失败。运行以下命令重试: npm install -g %s",
    step2Spinner: "正在安装 Skills...",
    step2Done: "Skills 已安装",
    step2FailNpx: "npx skills add 失败,尝试本地 skills sync 回退...",
    step2FailAll: "Skills 安装失败。可手动重试: rxcli skills sync",
    step3: "正在注册应用...",
    step3Skip: "已注册,跳过",
    step3Done: "注册完成",
    step3Fail: "注册失败。运行以下命令重试: rxcli auth register",
    step4: "授权",
    step4NotFound: "未找到 rxcli,跳过授权",
    step4Confirm: "是否允许 CLI 以你的名义访问公司应用接口?",
    step4Skip: "跳过授权。后续运行 rxcli auth login 完成授权",
    step4Done: "授权完成",
    step4Fail: "授权失败。运行以下命令重试: rxcli auth login",
    done: '安装完成!\n可以和你的 AI 工具说: "rxcli 能帮我做什么?"',
    cancelled: "安装已取消",
    nonTtyHint:
      "非交互环境,已完成 CLI 与 Skills 安装。请在终端中运行:\n  rxcli auth register\n  rxcli auth login",
  },
  en: {
    setup: "Setting up rxcli...",
    step1: "Installing %s globally...",
    step1Upgrade: "Upgrading %s (v%s → v%s)...",
    step1Skip: "Already installed (v%s). Skipped",
    step1Done: "Installed globally",
    step1Upgraded: "Upgraded to v%s",
    step1Fail: "Failed to install globally. Run manually: npm install -g %s",
    step2Spinner: "Installing skills...",
    step2Done: "Skills installed",
    step2FailNpx: "npx skills add failed, falling back to local skills sync...",
    step2FailAll: "Failed to install skills. Run manually: rxcli skills sync",
    step3: "Registering...",
    step3Skip: "Already registered. Skipped",
    step3Done: "Registered",
    step3Fail: "Failed to register. Run manually: rxcli auth register",
    step4: "Authorization",
    step4NotFound: "rxcli not found. Skipping authorization",
    step4Confirm: "Allow the CLI to access company APIs on your behalf?",
    step4Skip: "Skipped. Run rxcli auth login to authorize later",
    step4Done: "Authorization complete",
    step4Fail: "Failed to authorize. Run rxcli auth login to retry",
    done: 'All set!\nNow try asking your AI tool: "What can rxcli help me with?"',
    cancelled: "Installation cancelled",
    nonTtyHint:
      "Non-interactive: CLI and skills installed. Run in a terminal:\n  rxcli auth register\n  rxcli auth login",
  },
};

export function formatInstallMessage(template: string, ...values: (string | undefined)[]): string {
  let index = 0;
  return template.replace(/%s/g, () => values[index++] ?? "");
}

export function isOlderVersion(current: string, candidate: string): boolean {
  const parse = (value: string) => value.replace(/-.*$/, "").split(".").map(Number);
  const left = parse(current);
  const right = parse(candidate);
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return false;
  for (let index = 0; index < 3; index++) {
    if ((left[index] ?? 0) < (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) > (right[index] ?? 0)) return false;
  }
  return false;
}

export class InstallWorkflow {
  constructor(
    private readonly system: InstallSystem,
    private readonly presenter: InstallPresenter,
  ) {}

  async run(options: InstallWorkflowOptions): Promise<number> {
    const language = await this.resolveLanguage(options);
    if (!language) return 0;
    const text = messages[language];
    const auth = options.auth !== false;

    this.presenter.intro(text.setup);
    if (options.package.name && (await this.installCli(options.package.name, text)) !== 0) return 1;
    if ((await this.installSkills(options, text)) !== 0) return 1;

    if (!options.interactive) {
      if (auth) this.presenter.info(text.nonTtyHint);
      return 0;
    }

    if (auth) {
      if ((await this.register(options.package.bin, text)) !== 0) return 1;
      await this.authorize(options.package.bin, text);
    }
    this.presenter.outro(text.done);
    return 0;
  }

  private async resolveLanguage(options: InstallWorkflowOptions): Promise<InstallLanguage | null> {
    if (options.language) return options.language;
    if (!options.interactive) return "en";
    const language = await this.presenter.chooseLanguage();
    if (!language) this.presenter.cancel(messages.en.cancelled);
    return language;
  }

  private async installCli(packageName: string, text: Messages): Promise<number> {
    const [installed, latest] = await Promise.all([
      this.system.globallyInstalledVersion(packageName),
      this.system.latestVersion(packageName),
    ]);
    const upgrade = Boolean(
      installed && latest && installed !== "unknown" && isOlderVersion(installed, latest),
    );
    if (installed && !upgrade) {
      this.presenter.info(formatInstallMessage(text.step1Skip, installed));
      return 0;
    }

    this.presenter.start(
      upgrade
        ? formatInstallMessage(text.step1Upgrade, packageName, installed ?? "?", latest ?? "?")
        : formatInstallMessage(text.step1, packageName),
    );
    try {
      await this.system.installGlobally(packageName);
      this.presenter.succeed(
        upgrade ? formatInstallMessage(text.step1Upgraded, latest ?? "") : text.step1Done,
      );
      return 0;
    } catch {
      this.presenter.fail(formatInstallMessage(text.step1Fail, packageName));
      return 1;
    }
  }

  private async installSkills(options: InstallWorkflowOptions, text: Messages): Promise<number> {
    this.presenter.start(text.step2Spinner);
    if (options.skillsSource) {
      try {
        await this.system.installSkillsFrom(options.skillsSource);
        this.presenter.succeed(text.step2Done);
        return 0;
      } catch {
        this.presenter.update(text.step2FailNpx);
      }
    }

    const binary = await this.system.findBinary(options.package.bin);
    if (!binary) {
      this.presenter.fail(text.step2FailAll);
      return 1;
    }
    try {
      await this.system.syncSkills(binary);
      this.presenter.succeed(text.step2Done);
      return 0;
    } catch {
      this.presenter.fail(text.step2FailAll);
      return 1;
    }
  }

  private async register(binName: string, text: Messages): Promise<number> {
    if (await this.system.isRegistered()) {
      this.presenter.info(text.step3Skip);
      return 0;
    }
    this.presenter.start(text.step3);
    const binary = await this.system.findBinary(binName);
    if (!binary) {
      this.presenter.fail(text.step3Fail);
      return 1;
    }
    try {
      await this.system.register(binary);
      this.presenter.succeed(text.step3Done);
      return 0;
    } catch {
      this.presenter.fail(text.step3Fail);
      return 1;
    }
  }

  private async authorize(binName: string, text: Messages): Promise<void> {
    const binary = await this.system.findBinary(binName);
    if (!binary) {
      this.presenter.warn(text.step4NotFound);
      return;
    }
    const confirmed = await this.presenter.confirmLogin(text.step4Confirm);
    if (confirmed === null) {
      this.presenter.cancel(text.cancelled);
      return;
    }
    if (!confirmed) {
      this.presenter.info(text.step4Skip);
      return;
    }
    this.presenter.start(text.step4);
    try {
      await this.system.login(binary);
      this.presenter.succeed(text.step4Done);
    } catch {
      this.presenter.warn(text.step4Fail);
    }
  }
}
