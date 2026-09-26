// xAI subscription OAuth (device-code flow), same public client as the Grok CLI / Pi login.
// cc-enhance keeps its own token pair: xAI refresh tokens may rotate, so sharing one with Pi would
// invalidate the other host's copy.
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface OAuthTokens {
  kind: "oauth";
  access: string;
  refresh: string;
  /** Epoch ms after which the access token must be refreshed (skew already applied). */
  expires: number;
}
export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}
async function postForm(url: string, fields: Record<string, string>, signal?: AbortSignal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "error",
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, body };
}
const failure = (action: string, r: { status: number; body: Record<string, unknown> }) =>
  new Error(
    `xAI OAuth ${action} failed (HTTP ${r.status})${typeof r.body.error === "string" ? `: ${r.body.error}` : ""}`,
  );
function tokens(body: Record<string, unknown>, previousRefresh?: string): OAuthTokens {
  const access = body.access_token;
  const refresh = body.refresh_token ?? previousRefresh;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh)
    throw new Error("xAI OAuth returned no usable tokens.");
  const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return { kind: "oauth", access, refresh, expires: Date.now() + lifetime * 1000 - REFRESH_SKEW_MS };
}
export async function requestDeviceCode(): Promise<DeviceCode> {
  const r = await postForm(DEVICE_URL, { client_id: CLIENT_ID, scope: SCOPE, referrer: "cc-enhance" });
  if (!r.ok) throw failure("device authorization", r);
  const b = r.body;
  const uri = String(b.verification_uri_complete ?? b.verification_uri ?? "");
  if (!uri.startsWith("https://") || typeof b.device_code !== "string" || typeof b.user_code !== "string")
    throw new Error("Unexpected xAI device authorization response.");
  return {
    deviceCode: b.device_code,
    userCode: b.user_code,
    verificationUri: uri,
    intervalSeconds: typeof b.interval === "number" && b.interval > 0 ? b.interval : 5,
    expiresInSeconds: typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in : 900,
  };
}
export async function pollDeviceCode(device: DeviceCode): Promise<OAuthTokens> {
  let interval = device.intervalSeconds;
  const deadline = Date.now() + device.expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    const r = await postForm(TOKEN_URL, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: CLIENT_ID,
      device_code: device.deviceCode,
    });
    if (r.ok) return tokens(r.body);
    if (r.body.error === "authorization_pending") continue;
    if (r.body.error === "slow_down") {
      interval = typeof r.body.interval === "number" ? r.body.interval : interval + 5;
      continue;
    }
    throw failure("device token polling", r);
  }
  throw new Error("xAI device code expired before authorization.");
}
export async function refreshXai(refresh: string, signal?: AbortSignal): Promise<OAuthTokens> {
  const r = await postForm(
    TOKEN_URL,
    { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refresh },
    signal,
  );
  if (!r.ok) throw failure("token refresh", r);
  return tokens(r.body, refresh);
}
