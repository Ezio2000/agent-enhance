// xAI subscription OAuth. Refresh writes to the source that owns the token pair.
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface OAuthTokens {
  kind: "oauth";
  access: string;
  refresh: string;
  /** Epoch ms after which the access token must be refreshed (skew already applied). */
  expires: number;
}
async function postForm(url: string, fields: Record<string, string>, signal?: AbortSignal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
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
export async function refreshXai(refresh: string, signal?: AbortSignal): Promise<OAuthTokens> {
  const r = await postForm(
    TOKEN_URL,
    { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refresh },
    signal,
  );
  if (!r.ok) throw failure("token refresh", r);
  return tokens(r.body, refresh);
}
