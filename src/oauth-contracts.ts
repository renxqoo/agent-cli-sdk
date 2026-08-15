export type AuthStyle = "bearer" | "x-api-key" | "basic";

export interface DeviceAuthInfo {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface TokenInfo {
  access_token: string;
  refresh_token?: string;
  /** Lifetime in seconds. RFC 6749 makes this RECOMMENDED (optional), so it may be absent. */
  expires_in?: number;
  scope?: string;
}

export interface UserInfo {
  open_id: string;
  name: string;
}

export interface OAuthClientConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export type PollResult =
  | { status: "ok"; token: TokenInfo }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "error"; message: string };

export interface ClientMetadata {
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
  token_endpoint_auth_method?: string;
}

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  clientIdIssuedAt: number;
  clientSecretExpiresAt: number;
  clientMetadata: ClientMetadata;
}
