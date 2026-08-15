import {
  createLocalState,
  createMemoryLocalState,
  createUpdateNotifier,
  defineAuth,
  defineCliApp,
  defineInstaller,
} from "../src/index.js";
import type { ConfigStore } from "../src/credentials/types.js";

// 全链路:defineCliApp 一次装配 auth + installer + notifier(directory 决策只出现在 dir)
void defineCliApp({
  dir: "/tmp/my-cli-state",
  name: "my-cli",
  binName: "my-cli",
  description: "test",
  plugins: [
    defineAuth({ credentialNamespace: "my-cli", baseUrl: "https://auth.example.test" }),
    defineInstaller({ skillsSource: "https://skills.sh/p/xxx" }),
    createUpdateNotifier({ packageName: "@scope/my-cli", currentVersion: "1.0.0" }),
  ],
  commands: {},
});

// localState 注入变体(测试/嵌入式运行时)
void defineCliApp({
  localState: createMemoryLocalState(),
  name: "test",
  description: "test",
  commands: {},
});

// 旧参数一律报错(有意 breaking,不留兼容层)
void defineAuth({
  credentialNamespace: "legacy",
  baseUrl: "https://auth.example.test",
  // @ts-expect-error high-level auth no longer accepts a bare ConfigStore.
  store: {} as ConfigStore,
});

void defineAuth({
  credentialNamespace: "legacy",
  baseUrl: "https://auth.example.test",
  // @ts-expect-error localState is injected via apply(services), not a factory option.
  localState: createLocalState({ dir: "/tmp/x" }),
});

void defineAuth({
  credentialNamespace: "legacy",
  baseUrl: "https://auth.example.test",
  // @ts-expect-error authStyle removed: OAuth 2.1 tokens are Bearer (RFC 6750).
  authStyle: "x-api-key",
});

void defineAuth({
  credentialNamespace: "legacy",
  baseUrl: "https://auth.example.test",
  // @ts-expect-error poller removed: the factory no longer exposes a test poller seam.
  poller: async () => ({ status: "pending" as const }),
});

void defineAuth({
  credentialNamespace: "legacy",
  baseUrl: "https://auth.example.test",
  // @ts-expect-error scopeFromMetadata removed: scope is the single source of truth.
  scopeFromMetadata: true,
});

createUpdateNotifier({
  packageName: "legacy",
  currentVersion: "1.0.0",
  // @ts-expect-error update cache location is derived from localState.
  cacheDir: "/tmp/update-cache",
});

createUpdateNotifier({
  packageName: "legacy",
  currentVersion: "1.0.0",
  // @ts-expect-error localState is injected via apply(services).
  localState: createLocalState({ dir: "/tmp/x" }),
});

void defineInstaller({
  // @ts-expect-error install config location is derived from localState.
  configDir: "/tmp/config",
});

// ConfigStore 配置按 namespace 隔离
declare const store: ConfigStore;
// @ts-expect-error loadConfig requires a namespace.
void store.loadConfig();
void store.loadConfig("crm");
// @ts-expect-error saveConfig requires a namespace.
void store.saveConfig({});
void store.saveConfig("crm", { clientId: "x" });

// dir 与 localState 类型级互斥
// @ts-expect-error dir and localState are mutually exclusive.
void defineCliApp({
  dir: "/tmp/a",
  localState: createMemoryLocalState(),
  name: "x",
  description: "x",
  commands: {},
});
