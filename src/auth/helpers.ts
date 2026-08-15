/**
 * defineAuth 辅助纯函数:配置解析、注册 metadata 派生、provider chain 构造、on401 handler 构造。
 * 从 defineAuth 主体提取,每个函数职责单一,独立可测。
 */
import {
  OAuthClient,
  type ClientMetadata,
  type OAuthClientConfig,
  type TokenInfo,
} from "../oauth.js";
import { defaultProviders, type ConfigStore } from "../credentials/index.js";
import type { CredentialProvider } from "../credentials/types.js";
import type { AuthFlow, FlowType } from "../flows/types.js";
import { OAuthFlowCoordinator } from "./flow-coordinator.js";

// ============================================================================
// ① resolveAuthConfig:解析 clientId/secret(env → config/<ns>.json → 空)
// ============================================================================

export interface AuthConfig {
  oauth: OAuthClientConfig;
}

export interface ResolveAuthConfigInput {
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
}

export async function resolveAuthConfig(
  input: ResolveAuthConfigInput,
  store: ConfigStore,
  namespace: string,
): Promise<AuthConfig> {
  let clientId = input.clientId ?? process.env.RXCLI_CLIENT_ID ?? "";
  let clientSecret = input.clientSecret ?? process.env.RXCLI_CLIENT_SECRET ?? "";

  if (!clientId || !clientSecret) {
    const config = (await store.loadConfig(namespace)) as {
      clientId?: string;
      clientSecret?: string;
    };
    if (!clientId && config.clientId) clientId = config.clientId;
    if (!clientSecret && config.clientSecret) clientSecret = config.clientSecret;
  }

  return {
    oauth: { baseUrl: input.baseUrl, clientId, clientSecret },
  };
}

// ============================================================================
// ② resolveClientMetadata:RFC 7591 注册 metadata 的缺省派生
// ============================================================================

/** 各 OAuth 2.1 流程的默认 grant_types(与 crm 现有注册报文字节一致)。 */
const FLOW_GRANT_TYPES: Record<FlowType, string[]> = {
  device: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  authorization_code: ["authorization_code", "refresh_token"],
  client_credentials: ["client_credentials"],
};

export interface ResolveClientMetadataInput {
  credentialNamespace: string;
  flow: FlowType;
  scope?: string;
  clientMetadata?: ClientMetadata;
}

/**
 * 注册 metadata 按字段缺省派生(显式字段优先,hasOwnProperty 判断):
 *   client_name  ← credentialNamespace
 *   grant_types  ← flow 默认(见 FLOW_GRANT_TYPES)
 *   scope        ← opts.scope(业务只写一遍;注册声明与授权请求需要不同时显式覆盖)
 *   token_endpoint_auth_method ← "client_secret_basic"(机密客户端标准)
 */
export function resolveClientMetadata(input: ResolveClientMetadataInput): ClientMetadata {
  const explicit = input.clientMetadata;
  const has = (key: keyof ClientMetadata): boolean =>
    !!explicit && Object.prototype.hasOwnProperty.call(explicit, key);
  return {
    ...explicit,
    ...(has("client_name") ? {} : { client_name: input.credentialNamespace }),
    ...(has("grant_types") ? {} : { grant_types: FLOW_GRANT_TYPES[input.flow] }),
    ...(has("scope") ? {} : input.scope !== undefined ? { scope: input.scope } : {}),
    ...(has("token_endpoint_auth_method")
      ? {}
      : { token_endpoint_auth_method: "client_secret_basic" }),
  };
}

// ============================================================================
// ③ buildProviderChain:构造 provider chain(bearerToken 注入 + 自定义/默认)
// ============================================================================

export interface BuildProviderChainInput {
  bearerToken?: string;
  providers?: CredentialProvider[];
}

export function buildProviderChain(input: BuildProviderChainInput): CredentialProvider[] {
  const chain: CredentialProvider[] = [];

  if (input.bearerToken) {
    chain.push({
      name: () => "injected-bearer",
      priority: () => 0,
      async resolveToken() {
        return {
          token: input.bearerToken!,
          type: "bearer" as const,
          source: "injected:bearerToken",
        };
      },
    });
  }

  chain.push(...(input.providers ?? defaultProviders()));
  return chain;
}

// ============================================================================
// ④ buildOn401Handler:构造 401 续期 handler(两条路径统一 singleflight)
// ============================================================================

export interface BuildOn401Input {
  flow: AuthFlow;
  oauth: OAuthClientConfig;
  store: ConfigStore;
  namespace: string;
  /** 业务声明的 scope;client_credentials 续期时被持久化的已授予 scopes 覆盖。 */
  scope?: string;
}

export function buildOn401Handler(input: BuildOn401Input): () => Promise<TokenInfo | null> {
  const { flow, oauth, store, namespace, scope } = input;
  const coordinator = new OAuthFlowCoordinator({
    store,
    namespace,
    strategy: flow.refresh
      ? {
          // client_credentials: re-request the EXACT scope envelope that was granted at
          // login (persisted), not the static opts.scope. L2 — login and refresh now
          // share one scope source.
          type: flow.type,
          acquire: (ctx) =>
            flow.refresh!({
              type: "client_credentials" as const,
              cfg: oauth,
              scope: ctx.scopes && ctx.scopes.length ? ctx.scopes.join(" ") : scope,
            }),
        }
      : {
          requiresRefreshToken: true,
          acquire: (ctx) => new OAuthClient(oauth).refresh(ctx.refreshToken!),
        },
  });
  return coordinator.refreshStoredSession;
}
