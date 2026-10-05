// "Sign in with ChatGPT" with plan usage, for open-source apps that run locally.
// Implemented from OpenAI's public protocol docs (developers.openai.com/siwc);
// no code from the noncommercial devkit is used.
import { shell } from "electron";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { loadEncryptedJson, loadPlainJson, saveEncryptedJson, savePlainJson } from "./store";
import { t, type MessageKey } from "../shared/i18n";
import type { ChatGPTStatus } from "../shared/types";
import {
  APP_NAME,
  PLAN_SCOPE,
  TokenError,
  createTokenKeeper,
  finishCallback,
  isConnected,
  waitForCallback,
  withoutTokens,
  type AuthRecord,
  type Callback,
} from "./chatgpt-auth-core";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const PREFERRED_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const AUTH_FILE = "chatgpt-auth.bin";
// The browser tab now waits for the token exchange, so a hanging request must not hang it forever.
const TOKEN_TIMEOUT_MS = 30_000;

let language: () => string = () => "en";

/** Errors and the browser pages follow this language; main passes the language of the settings. */
export function setLanguage(get: () => string): void {
  language = get;
}

const tr = (key: MessageKey, vars?: Record<string, string | number>) => t(language(), key, vars);

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hostId(): string {
  const saved = loadPlainJson<{ ext_agent_host_id?: string }>("chatgpt-host.json", {});
  if (saved.ext_agent_host_id) return saved.ext_agent_host_id;
  const id = `urn:uuid:${randomUUID()}`;
  savePlainJson("chatgpt-host.json", { ext_agent_host_id: id });
  return id;
}

function load(): AuthRecord | null {
  return loadEncryptedJson<AuthRecord>(AUTH_FILE);
}

function save(r: AuthRecord): void {
  saveEncryptedJson(AUTH_FILE, r);
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
async function getJwks() {
  if (jwks) return jwks;
  let uri = `${ISSUER}/.well-known/jwks.json`;
  try {
    const conf: any = await (await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })).json();
    if (typeof conf.jwks_uri === "string") uri = conf.jwks_uri;
  } catch {
    /* fall back to the default location */
  }
  jwks = createRemoteJWKSet(new URL(uri));
  return jwks;
}

async function tokenRequest(params: Record<string, string>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    // Not a TokenError on purpose: a network problem must never count as a dead session.
    throw new Error(tr("auth.cannotReach"));
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof body.error === "string" ? body.error : undefined;
    throw new TokenError(tr("auth.failedWith", { reason: body.error_description ?? code ?? res.status }), res.status, code);
  }
  return body;
}

function listen(): Promise<{ server: Server; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const tryPort = (port: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (port !== 0 && err.code === "EADDRINUSE") tryPort(0);
        else reject(err);
      });
      server.listen(port, "127.0.0.1", () => {
        const p = (server.address() as AddressInfo).port;
        resolve({ server, redirectUri: `http://127.0.0.1:${p}${CALLBACK_PATH}` });
      });
    };
    tryPort(PREFERRED_PORT);
  });
}

/** Opens the system browser, waits for the callback and stores the credentials. */
export async function signIn(): Promise<ChatGPTStatus> {
  const prev = load();
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const { server, redirectUri } = await listen();
  let cb: Callback | undefined;

  try {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: prev?.client_id ?? "dynamic_agent_client",
      ext_agent_host_id: hostId(),
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    if (!prev?.client_id) q.set("agent_name_hint", APP_NAME);
    if (prev?.id_token) q.set("id_token_hint", prev.id_token);
    if (prev?.email) q.set("login_hint", prev.email);

    // Only resolves for a request that carries our state, so a stray local hit cannot end the sign-in.
    const callbackPromise = waitForCallback(server, CALLBACK_PATH, state, 5 * 60 * 1000, language());
    await shell.openExternal(`${AUTHORIZE_URL}?${q.toString()}`);
    cb = await callbackPromise;
    const params = cb.params;

    const error = params.get("error");
    if (error) throw new Error(error === "access_denied" ? tr("auth.denied") : tr("auth.failedWith", { reason: error }));
    const code = params.get("code");
    if (!code) throw new Error(tr("auth.noCode"));

    let clientId = prev?.client_id;
    const returned = params.get("client_id");
    if (!clientId) {
      if (!returned || returned === "dynamic_agent_client") throw new Error(tr("auth.noClientId"));
      clientId = returned;
      save({ client_id: clientId, scopes: [] }); // keep the registration even if the exchange fails
    } else if (returned && returned !== clientId) {
      throw new Error(tr("auth.unexpectedClient"));
    }

    const tok = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: RESOURCE,
    });
    if (!tok.id_token) throw new Error(tr("auth.noIdToken"));
    const { payload } = await jwtVerify(tok.id_token, await getJwks(), { issuer: ISSUER, audience: clientId });
    if (payload.nonce !== nonce) throw new Error(tr("auth.nonce"));
    if (prev?.subject && prev.subject !== payload.sub) throw new Error(tr("auth.otherAccount"));

    save({
      email: typeof payload.email === "string" ? payload.email : prev?.email,
      subject: payload.sub,
      client_id: clientId,
      id_token: tok.id_token,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
      scopes: String(tok.scope ?? "").split(/\s+/).filter(Boolean),
    });
    // Only now does the browser tab say "Signed in": every check above could still fail.
    finishCallback(cb.res, undefined, language());
  } catch (err) {
    if (cb) finishCallback(cb.res, err, language());
    throw err;
  } finally {
    server.close();
  }
  return status();
}

export function signOut(): void {
  const r = load();
  if (!r) return;
  // Keep the registration (client id) so a later sign-in reuses it; drop tokens.
  save(withoutTokens(r));
}

const tokens = createTokenKeeper({
  load,
  save,
  refresh: (clientId, refreshToken) =>
    tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, resource: RESOURCE }),
  lang: () => language(),
});

/** A valid access token for plan usage, refreshed when needed. Concurrent callers share one refresh. */
export async function getAccessToken(): Promise<string> {
  return tokens.getAccessToken();
}

export async function listModels(): Promise<{ slug: string; displayName: string }[]> {
  const token = await getAccessToken();
  const res = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(tr("auth.modelsFailed", { status: res.status }));
  const body: any = await res.json();
  const list: any[] = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : [];
  return list
    .filter((m) => !m.visibility || m.visibility === "list")
    .map((m) => ({ slug: m.slug ?? m.id, displayName: m.display_name ?? m.slug ?? m.id }));
}

export function status(): ChatGPTStatus {
  const r = load();
  // An expired token without a refresh token, or one cleared after a dead refresh, is not a connection.
  const connected = isConnected(r, Date.now());
  return { connected, sharing: connected && !!r?.scopes.includes(PLAN_SCOPE), email: r?.email, models: [] };
}

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
