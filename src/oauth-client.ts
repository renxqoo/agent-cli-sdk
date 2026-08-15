import { APIError, AuthenticationError, InternalError, NetworkError } from "./errs/index.js";
import type {
  ClientMetadata,
  DeviceAuthInfo,
  OAuthClientConfig,
  PollResult,
  RegisteredClient,
  TokenInfo,
  UserInfo,
} from "./oauth-contracts.js";

type OAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Deep OAuth protocol boundary: transport, wire encoding, decoding and error taxonomy. */
export class OAuthClient {
  constructor(
    readonly config: OAuthClientConfig,
    private readonly fetcher: OAuthFetch = globalThis.fetch,
  ) {}

  async authorizeDevice(scope?: string): Promise<DeviceAuthInfo> {
    const form = new URLSearchParams();
    if (scope) form.set("scope", scope);
    const response = await this.request("/device_authorization", this.formRequest(form, true));
    const body = await decodeJson(response);
    if (!response.ok) throw apiFailure(response, "device_authorization failed", body);
    const value = objectBody(body, "device_authorization");
    return {
      device_code: stringField(value, "device_code", "device_authorization"),
      user_code: stringField(value, "user_code", "device_authorization"),
      verification_uri: stringField(value, "verification_uri", "device_authorization"),
      ...(typeof value.verification_uri_complete === "string"
        ? { verification_uri_complete: value.verification_uri_complete }
        : {}),
      expires_in: numberField(value, "expires_in", "device_authorization"),
      interval: numberField(value, "interval", "device_authorization"),
    };
  }

  async pollDevice(deviceCode: string): Promise<PollResult> {
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: this.config.clientId,
    });
    const response = await this.request("/token", this.formRequest(form, true));
    const raw = await decodeJson(response);
    if (response.ok) return { status: "ok", token: tokenInfo(raw, "device token") };
    const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const error = typeof body.error === "string" ? body.error : "";
    if (error === "authorization_pending") return { status: "pending" };
    if (error === "slow_down") return { status: "slow_down" };
    const description =
      typeof body.error_description === "string" ? body.error_description : undefined;
    return {
      status: "error",
      message:
        description ??
        (["expired_token", "access_denied", "invalid_grant"].includes(error)
          ? error
          : `poll failed (${response.status})`),
    };
  }

  async refresh(refreshToken: string): Promise<TokenInfo> {
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
    const response = await this.request("/token", this.formRequest(form, true));
    const body = await decodeJson(response);
    if (!response.ok) {
      throw new AuthenticationError({
        subtype: "token_expired",
        message: "Refresh token is invalid, please log in again",
        hint: "run `rxcli auth login` to log in again",
        cause: body,
      });
    }
    return tokenInfo(body, "refresh token");
  }

  async userInfo(accessToken: string): Promise<UserInfo> {
    const response = await this.request("/user_info", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = await decodeJson(response);
    if (response.status === 401) {
      throw new AuthenticationError({
        subtype: "token_expired",
        code: 401,
        message: "Authentication expired",
        cause: body,
      });
    }
    if (!response.ok) throw apiFailure(response, "user_info failed", body);
    const value = objectBody(body, "user_info");
    return {
      open_id: stringField(value, "open_id", "user_info"),
      name: stringField(value, "name", "user_info"),
    };
  }

  async revoke(
    token: string,
    hint: "access_token" | "refresh_token" = "access_token",
  ): Promise<void> {
    const form = new URLSearchParams({ token, token_type_hint: hint });
    const response = await this.request("/revoke", this.formRequest(form, false));
    if (!response.ok) throw apiFailure(response, "revoke failed");
  }

  async register(registrationToken: string, metadata?: ClientMetadata): Promise<RegisteredClient> {
    const response = await this.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ registrationToken, ...metadata }),
    });
    const body = await decodeJson(response);
    if (!response.ok) {
      const description = (body as { error_description?: unknown } | undefined)?.error_description;
      throw apiFailure(
        response,
        typeof description === "string" ? description : "register failed",
        body,
      );
    }
    const value = objectBody(body, "register");
    return {
      clientId: stringField(value, "client_id", "register"),
      clientSecret: stringField(value, "client_secret", "register"),
      clientIdIssuedAt:
        typeof value.client_id_issued_at === "number"
          ? value.client_id_issued_at
          : Math.floor(Date.now() / 1000),
      clientSecretExpiresAt:
        typeof value.client_secret_expires_at === "number" ? value.client_secret_expires_at : 0,
      clientMetadata: metadataFrom(value),
    };
  }

  async exchangeCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<TokenInfo> {
    const publicClient = !this.config.clientSecret;
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
      ...(publicClient ? { client_id: this.config.clientId } : {}),
    });
    const response = await this.request("/token", this.formRequest(form, !publicClient));
    const body = await decodeJson(response);
    if (!response.ok) throw apiFailure(response, "authorization_code exchange failed", body);
    return tokenInfo(body, "authorization_code token");
  }

  async clientCredentials(scope?: string): Promise<TokenInfo> {
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (scope) form.set("scope", scope);
    const response = await this.request("/token", this.formRequest(form, true));
    const body = await decodeJson(response);
    if (!response.ok) throw apiFailure(response, "client_credentials token failed", body);
    return tokenInfo(body, "client_credentials token");
  }

  private formRequest(form: URLSearchParams, authenticate: boolean): RequestInit {
    return {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(authenticate ? { authorization: this.basicAuthorization() } : {}),
      },
      body: form.toString(),
    };
  }

  private basicAuthorization(): string {
    return `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetcher(`${this.config.baseUrl}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const timeout =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new NetworkError({
        subtype: timeout ? "timeout" : "connection_refused",
        message: timeout
          ? "OAuth request timed out (30000ms)"
          : `OAuth network error: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
        cause: error,
      });
    }
  }
}

async function decodeJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new NetworkError({
      subtype: "connection_refused",
      message: `Failed to read OAuth response: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
      cause: error,
    });
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new InternalError({
      subtype: "decode_failure",
      message:
        "OAuth response is not valid JSON (the gateway may have returned an HTML error page)",
      cause: text.slice(0, 200),
    });
  }
}

function objectBody(body: unknown, endpoint: string): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InternalError({
      subtype: "contract_violation",
      message: `${endpoint} response has invalid structure: expected object`,
      cause: body,
    });
  }
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string, endpoint: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value) throw missingField(body, key, endpoint, "string");
  return value;
}

function numberField(body: Record<string, unknown>, key: string, endpoint: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw missingField(body, key, endpoint, "number");
  }
  return value;
}

function missingField(
  body: Record<string, unknown>,
  key: string,
  endpoint: string,
  type: string,
): InternalError {
  return new InternalError({
    subtype: "contract_violation",
    message: `${endpoint} response is missing ${type} field ${key}`,
    cause: body,
  });
}

function tokenInfo(body: unknown, endpoint: string): TokenInfo {
  const value = objectBody(body, endpoint);
  const expiresIn = value.expires_in;
  return {
    access_token: stringField(value, "access_token", endpoint),
    ...(typeof expiresIn === "number" && Number.isFinite(expiresIn)
      ? { expires_in: expiresIn }
      : {}),
    ...(typeof value.refresh_token === "string" && value.refresh_token
      ? { refresh_token: value.refresh_token }
      : {}),
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
  };
}

function metadataFrom(value: Record<string, unknown>): ClientMetadata {
  return {
    ...(typeof value.client_name === "string" ? { client_name: value.client_name } : {}),
    ...(Array.isArray(value.redirect_uris)
      ? { redirect_uris: value.redirect_uris as string[] }
      : {}),
    ...(Array.isArray(value.grant_types) ? { grant_types: value.grant_types as string[] } : {}),
    ...(Array.isArray(value.response_types)
      ? { response_types: value.response_types as string[] }
      : {}),
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
    ...(typeof value.token_endpoint_auth_method === "string"
      ? { token_endpoint_auth_method: value.token_endpoint_auth_method }
      : {}),
  };
}

function apiFailure(response: Response, message: string, cause?: unknown): APIError {
  return new APIError({
    subtype: "server_error",
    code: response.status,
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}
