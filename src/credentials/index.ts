/**
 * @renxqoo/agent-cli-sdk/credentials —— 凭证与 provider chain 公共入口
 *
 * 子路径导出(供自定义 provider 实现者用):
 *   import type { CredentialProvider, ConfigStore } from '@renxqoo/agent-cli-sdk/credentials'
 *   import { fileStore, memoryStore } from '@renxqoo/agent-cli-sdk/credentials'
 */

export type {
  ConfigStore,
  CredentialProvider,
  ProviderContext,
  TokenResult,
  IdentityHint,
  StoredOAuthCredentials,
} from "./types.js";

export { fileStore, memoryStore, type FileStoreOptions } from "./config-store.js";

export {
  flagProvider,
  envProvider,
  envBearerProvider,
  fileProvider,
  oauthProvider,
  defaultProviders,
  resolveWithChain,
  resolveIdentityWithChain,
} from "./providers.js";
