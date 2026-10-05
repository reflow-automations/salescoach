import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  NOT_SIGNED_IN,
  PLAN_SCOPE,
  SESSION_EXPIRED,
  TokenError,
  createTokenKeeper,
  escapeHtml,
  finishCallback,
  isConnected,
  isDeadRefresh,
  waitForCallback,
  type AuthRecord,
  type TokenResponse,
} from "./chatgpt-auth-core";

const NOW = 1_000_000_000;

function record(over: Partial<AuthRecord> = {}): AuthRecord {
  return {
    email: "rogier@example.com",
    subject: "user-1",
    client_id: "client-1",
    id_token: "id-1",
    access_token: "at-1",
    refresh_token: "rt-1",
    expires_at: NOW + 10_000, // inside the 60 s margin, so it needs a refresh
    scopes: [PLAN_SCOPE],
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An in-memory disk plus a token endpoint the test answers by hand. */
function harness(initial: AuthRecord | null) {
  let disk: AuthRecord | null = initial ? structuredClone(initial) : null;
  const calls: { clientId: string; refreshToken: string; reply: ReturnType<typeof deferred<TokenResponse>> }[] = [];
  const keeper = createTokenKeeper({
    load: () => (disk ? structuredClone(disk) : null),
    save: (r) => {
      disk = structuredClone(r);
    },
    refresh: (clientId, refreshToken) => {
      const reply = deferred<TokenResponse>();
      calls.push({ clientId, refreshToken, reply });
      return reply.promise;
    },
    now: () => NOW,
  });
  return {
    keeper,
    calls,
    disk: () => disk,
    setDisk: (r: AuthRecord | null) => {
      disk = r ? structuredClone(r) : null;
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test("a fresh token is returned without a refresh", async () => {
  const h = harness(record({ expires_at: NOW + 10 * 60_000 }));
  assert.equal(await h.keeper.getAccessToken(), "at-1");
  assert.equal(h.calls.length, 0);
});

test("concurrent callers share one refresh, so the rotating refresh token is sent once", async () => {
  const h = harness(record());
  const a = h.keeper.getAccessToken();
  const b = h.keeper.getAccessToken();
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].refreshToken, "rt-1");
  h.calls[0].reply.resolve({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
  assert.deepEqual(await Promise.all([a, b]), ["at-2", "at-2"]);
  assert.equal(h.disk()?.refresh_token, "rt-2");
  assert.equal(h.disk()?.access_token, "at-2");
  assert.equal(h.disk()?.expires_at, NOW + 3600_000);
  assert.equal(h.disk()?.email, "rogier@example.com");
  // The next call uses the stored fresh token; no second POST.
  assert.equal(await h.keeper.getAccessToken(), "at-2");
  assert.equal(h.calls.length, 1);
});

test("a sign-out during a refresh is not undone and the waiting caller gets no token", async () => {
  const h = harness(record());
  const p = h.keeper.getAccessToken();
  await tick();
  h.setDisk({ client_id: "client-1", email: "rogier@example.com", scopes: [] }); // signOut()
  h.calls[0].reply.resolve({ access_token: "at-2", refresh_token: "rt-2" });
  await assert.rejects(p, { message: NOT_SIGNED_IN });
  assert.equal(h.disk()?.access_token, undefined);
  assert.equal(h.disk()?.refresh_token, undefined);
});

test("a new sign-in during a refresh is not overwritten by the stale result", async () => {
  const h = harness(record());
  const p = h.keeper.getAccessToken();
  await tick();
  h.setDisk(record({ access_token: "at-new", refresh_token: "rt-new", expires_at: NOW + 3600_000 })); // signIn()
  h.calls[0].reply.resolve({ access_token: "at-2", refresh_token: "rt-2" });
  assert.equal(await p, "at-new");
  assert.equal(h.disk()?.refresh_token, "rt-new");
});

test("a dead refresh token clears the tokens, keeps the registration and reports disconnected", async () => {
  const h = harness(record());
  const p = h.keeper.getAccessToken();
  await tick();
  h.calls[0].reply.reject(new TokenError("Inloggen mislukt: invalid_grant", 400, "invalid_grant"));
  await assert.rejects(p, { message: SESSION_EXPIRED });
  assert.deepEqual(h.disk(), { client_id: "client-1", email: "rogier@example.com", scopes: [] });
  assert.equal(isConnected(h.disk(), NOW), false);
  await assert.rejects(h.keeper.getAccessToken(), { message: NOT_SIGNED_IN });
});

test("a network error or 5xx keeps the session and the next call tries again", async () => {
  const h = harness(record());
  const p = h.keeper.getAccessToken();
  await tick();
  h.calls[0].reply.reject(new Error("Kan de inlogserver van OpenAI niet bereiken."));
  await assert.rejects(p, { message: "Kan de inlogserver van OpenAI niet bereiken." });
  assert.equal(h.disk()?.refresh_token, "rt-1");

  const q = h.keeper.getAccessToken();
  await tick();
  assert.equal(h.calls.length, 2);
  h.calls[1].reply.reject(new TokenError("Inloggen mislukt: 503", 503));
  await assert.rejects(q, { message: "Inloggen mislukt: 503" });
  assert.equal(h.disk()?.refresh_token, "rt-1");
  assert.equal(isConnected(h.disk(), NOW), true);
});

test("a rejected refresh uses the token another instance stored meanwhile instead of clearing it", async () => {
  const h = harness(record());
  const p = h.keeper.getAccessToken();
  await tick();
  h.setDisk(record({ access_token: "at-other", refresh_token: "rt-other", expires_at: NOW + 3600_000 }));
  h.calls[0].reply.reject(new TokenError("Inloggen mislukt: refresh_token_reused", 400, "refresh_token_reused"));
  assert.equal(await p, "at-other");
  assert.equal(h.disk()?.refresh_token, "rt-other");
});

test("only 400 and 401 token errors count as a dead session", () => {
  assert.equal(isDeadRefresh(new TokenError("x", 400, "invalid_grant")), true);
  assert.equal(isDeadRefresh(new TokenError("x", 401)), true);
  assert.equal(isDeadRefresh(new TokenError("x", 429)), false);
  assert.equal(isDeadRefresh(new TokenError("x", 500)), false);
  assert.equal(isDeadRefresh(new Error("fetch failed")), false);
});

test("isConnected needs a token that is valid or can be refreshed", () => {
  assert.equal(isConnected(null, NOW), false);
  assert.equal(isConnected({ client_id: "c", scopes: [] }, NOW), false);
  assert.equal(isConnected(record({ expires_at: NOW - 1 }), NOW), true);
  assert.equal(isConnected(record({ expires_at: NOW - 1, refresh_token: undefined }), NOW), false);
  assert.equal(isConnected(record({ expires_at: NOW + 1000, refresh_token: undefined }), NOW), true);
});

// ---- loopback callback ----

async function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function stop(server: Server): void {
  server.close();
  server.closeAllConnections();
}

test("the callback ignores requests with a wrong state and resolves on the matching one", async () => {
  const { server, base } = await startServer();
  try {
    let resolved = false;
    const wait = waitForCallback(server, "/auth/callback", "good-state", 5_000).then((cb) => {
      resolved = true;
      return cb;
    });

    const stray = await fetch(`${base}/auth/callback?state=evil&code=x`);
    assert.equal(stray.status, 400);
    assert.match(await stray.text(), /expired or is not valid/);
    const noState = await fetch(`${base}/auth/callback?code=x`);
    assert.equal(noState.status, 400);
    await noState.text();
    const other = await fetch(`${base}/favicon.ico`);
    assert.equal(other.status, 404);
    await other.text();
    await tick();
    assert.equal(resolved, false);

    const real = fetch(`${base}/auth/callback?state=good-state&code=abc`);
    const cb = await wait;
    assert.equal(cb.params.get("code"), "abc");
    // The tab only hears back once the caller has finished.
    finishCallback(cb.res);
    const page = await real;
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Signed in\./);
    assert.match(html, /<html lang="en">/);

    // A second hit after that, e.g. a refreshed tab, is answered but changes nothing.
    const again = await fetch(`${base}/auth/callback?state=good-state&code=abc`);
    assert.equal(again.status, 400);
    await again.text();
  } finally {
    stop(server);
  }
});

test("an error callback shows a failure page with the reason, never Gelukt (in Dutch)", async () => {
  const { server, base } = await startServer();
  try {
    const wait = waitForCallback(server, "/auth/callback", "s", 5_000);
    const real = fetch(`${base}/auth/callback?state=s&error=access_denied`);
    const cb = await wait;
    assert.equal(cb.params.get("error"), "access_denied");
    finishCallback(cb.res, new Error("Je hebt geen toestemming gegeven <script>."), "nl");
    const page = await real;
    const html = await page.text();
    assert.equal(page.status, 400);
    assert.doesNotMatch(html, /Gelukt/);
    assert.match(html, /Inloggen is niet gelukt/);
    assert.match(html, /<html lang="nl">/);
    assert.match(html, /Je hebt geen toestemming gegeven &#60;script&#62;\./);
    // Writing a second time is a no-op instead of a crash.
    finishCallback(cb.res);
  } finally {
    stop(server);
  }
});

test("the callback wait times out", async () => {
  const { server } = await startServer();
  try {
    await assert.rejects(waitForCallback(server, "/auth/callback", "s", 20), { message: "Sign-in took too long." });
  } finally {
    stop(server);
  }
});

test("escapeHtml escapes markup characters", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;");
});
