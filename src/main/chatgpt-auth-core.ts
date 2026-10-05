// Electron-free parts of "Sign in with ChatGPT": the token refresh rules and the
// loopback callback. Kept apart from chatgpt-auth.ts so node:test can cover them.
import type { Server, ServerResponse } from "node:http";
import { normLang, t } from "../shared/i18n";

export const APP_NAME = "Salescoach";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
/** The English texts; with `lang` the keeper uses the language of the settings. */
export const NOT_SIGNED_IN = t("en", "auth.notSignedIn");
export const SESSION_EXPIRED = t("en", "auth.sessionExpired");
// Refresh a bit before expiry, so a token never runs out halfway through a request.
const REFRESH_MARGIN_MS = 60_000;

export interface AuthRecord {
  email?: string;
  subject?: string;
  client_id: string;
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  scopes: string[];
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number | string;
  scope?: string;
}

/** An HTTP error from the token endpoint, with its status and OAuth error code. */
export class TokenError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A 400/401 on a refresh means the grant is dead (expired, revoked or reused); retrying cannot help. Network errors and 5xx are not. */
export function isDeadRefresh(err: unknown): boolean {
  return err instanceof TokenError && (err.status === 400 || err.status === 401);
}

/** The record without tokens. The client id stays, so the next sign-in reuses the registration. */
export function withoutTokens(r: AuthRecord): AuthRecord {
  return { client_id: r.client_id, email: r.email, scopes: [] };
}

/** Signed in means an access token that is still valid or can still be refreshed. */
export function isConnected(r: AuthRecord | null, now: number): boolean {
  return !!r?.access_token && (!!r.refresh_token || (r.expires_at ?? 0) > now);
}

export interface TokenKeeperDeps {
  load(): AuthRecord | null;
  save(r: AuthRecord): void;
  /** POSTs grant_type=refresh_token. Throws TokenError on an HTTP error. */
  refresh(clientId: string, refreshToken: string): Promise<TokenResponse>;
  now?: () => number;
  /** Language of the error texts ("en" or "nl"). Default English. */
  lang?: () => string;
}

export function createTokenKeeper(deps: TokenKeeperDeps): { getAccessToken(): Promise<string> } {
  const now = deps.now ?? Date.now;
  const lang = deps.lang ?? (() => "en");
  // Refresh tokens rotate: a second POST with the same token is rejected as reused
  // (and can revoke the whole session), so concurrent callers share one refresh.
  let refreshing: { rt: string; p: Promise<string> } | null = null;

  async function getAccessToken(): Promise<string> {
    const r = deps.load();
    if (!r?.access_token) throw new Error(t(lang(), "auth.notSignedIn"));
    if (!r.scopes.includes(PLAN_SCOPE)) throw new Error(t(lang(), "auth.planOff"));
    if ((r.expires_at ?? 0) - now() > REFRESH_MARGIN_MS) return r.access_token;
    if (!r.refresh_token) throw new Error(t(lang(), "auth.sessionExpired"));
    if (refreshing && refreshing.rt === r.refresh_token) return refreshing.p;
    const rt = r.refresh_token;
    const p: Promise<string> = refresh(r, rt).finally(() => {
      if (refreshing?.p === p) refreshing = null;
    });
    refreshing = { rt, p };
    return p;
  }

  async function refresh(r: AuthRecord, usedRt: string): Promise<string> {
    let tok: TokenResponse;
    try {
      tok = await deps.refresh(r.client_id, usedRt);
    } catch (err) {
      const cur = deps.load();
      // Signed out, signed in again or refreshed by another instance meanwhile: go by what is stored now.
      if (cur?.refresh_token !== usedRt) return getAccessToken();
      if (!isDeadRefresh(err)) throw err;
      // Clear the dead tokens so status() stops reporting a connection that cannot work.
      deps.save(withoutTokens(cur));
      throw new Error(t(lang(), "auth.sessionExpired"));
    }
    // Re-read before writing, so a stale record never undoes a sign-out or overwrites a newer sign-in.
    const cur = deps.load();
    if (cur?.refresh_token !== usedRt) return getAccessToken();
    deps.save({
      ...cur,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? usedRt,
      expires_at: now() + (Number(tok.expires_in) || 3600) * 1000,
      scopes: tok.scope ? String(tok.scope).split(/\s+/).filter(Boolean) : cur.scopes,
    });
    return tok.access_token;
  }

  return { getAccessToken };
}

// ---- loopback callback ----

export interface Callback {
  params: URLSearchParams;
  /** Left open: the caller writes the result page once sign-in has really finished. */
  res: ServerResponse;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sendPage(res: ServerResponse, statusCode: number, html: string, lang: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
  res.end(`<!doctype html><html lang="${normLang(lang)}"><meta charset="utf-8"><title>${APP_NAME}</title><body style="font-family:system-ui;padding:40px">${html}</body></html>`);
}

/** Answers the browser tab: "Signed in" without an error, otherwise the reason in plain words. */
export function finishCallback(res: ServerResponse, err?: unknown, lang = "en"): void {
  const app = { app: APP_NAME };
  if (err === undefined) {
    sendPage(res, 200, `<p>${escapeHtml(t(lang, "auth.pageSuccess", app))}</p>`, lang);
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  sendPage(
    res,
    400,
    `<p><strong>${escapeHtml(t(lang, "auth.pageFailed"))}</strong></p><p>${escapeHtml(msg)}</p><p>${escapeHtml(t(lang, "auth.pageBack", app))}</p>`,
    lang,
  );
}

/** Resolves on the first request to `path` that carries `expectedState`. */
export function waitForCallback(server: Server, path: string, expectedState: string, timeoutMs: number, lang = "en"): Promise<Callback> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new Error(t(lang, "auth.tooLong")));
    }, timeoutMs);
    server.once("close", () => clearTimeout(timer));
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      // Any local web page can hit this port. Only the redirect with our own state counts;
      // anything else gets an answer and is ignored, so it cannot break the sign-in.
      if (done || url.searchParams.get("state") !== expectedState) {
        sendPage(res, 400, `<p>${escapeHtml(t(lang, "auth.pageExpired"))}</p><p>${escapeHtml(t(lang, "auth.pageBack", { app: APP_NAME }))}</p>`, lang);
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve({ params: url.searchParams, res });
    });
  });
}
