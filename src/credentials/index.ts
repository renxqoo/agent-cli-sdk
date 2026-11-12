/**
 * @myriosx/cli-kit/credentials —— 凭证与 provider chain 公共入口
 *
 * 子路径导出(供自定义 provider 实现者用):
 *   import type { CredentialProvider, ConfigStore } from '@myriosx/cli-kit/credentials'
 *   import { fileStore, memoryStore } from '@myriosx/cli-kit/credentials'
 */

export type {
  ConfigStore,
  CredentialTransaction,
  OAuthSessionRef,
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
} from "./providers.js";
