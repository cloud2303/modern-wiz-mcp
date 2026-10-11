import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { WizAuthManager, type AuthConfig, type Account } from "../src/auth.js";
import { WizError } from "../src/errors.js";

const account: Account = { kbServer: "https://test.wiz.cn", kbGuid: "kb", userGuid: "user", token: "old-token", autoLoginParams: "auto-secret", displayName: "Test" };
function fixture(t: TestContext, extra: Partial<AuthConfig> = {}): AuthConfig {
  const directory = mkdtempSync(join(tmpdir(), "wiz-mcp-auth-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    token: account.token, autoLoginParams: account.autoLoginParams, serverUrl: account.kbServer,
    kbGuid: account.kbGuid, userGuid: account.userGuid,
    sessionPath: join(directory, "session.json"), refreshIntervalMs: 1000, timeoutMs: 1000,
    ...extra,
  };
}
function upstream(handler: (url: URL, init: RequestInit) => Promise<Response> | Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(new URL(input instanceof Request ? input.url : String(input)), init ?? {})) as typeof fetch;
}
const isCode = (code: string) => (error: unknown) => error instanceof WizError && error.code === code;
const freshResponse = (patch: Partial<Account> = {}) => Response.json({ returnCode: 200, result: { ...account, token: "fresh-token", ...patch }, wizAutoLoginParams: "rotated-auto-secret" });

test("token-only configuration resolves account identity via token-login without password", async t => {
  const config = fixture(t, { serverUrl: undefined, kbGuid: undefined, userGuid: undefined, autoLoginParams: undefined });
  const auth = new WizAuthManager(config, { fetch: upstream((url, init) => {
    assert.equal(url.origin, "https://as.wiz.cn");
    assert.equal(url.pathname, "/as/user/login/token");
    assert.equal(url.searchParams.get("token"), "old-token");
    assert.equal(init.method, "POST");
    assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).get("x-wiz-token"), null);
    return freshResponse();
  }) });
  const resolved = await auth.getAccount();
  assert.equal(resolved.userGuid, "user");
  assert.equal(resolved.token, "fresh-token");
  assert.equal(resolved.autoLoginParams, "rotated-auto-secret");
});

test("concurrent expired requests share one rotation, retry once and adopt the new server", async t => {
  let refreshes = 0;
  let retries = 0;
  const auth = new WizAuthManager(fixture(t), { fetch: upstream(async (url, init) => {
    if (url.pathname === "/as/user/login/auto") {
      refreshes++;
      assert.equal(new Headers(init.headers).get("wiz-auto-login-param"), "auto-secret");
      await nextTurn();
      return freshResponse({ kbServer: "https://next.wiz.cn" });
    }
    if (new Headers(init.headers).get("x-wiz-token") === "old-token") return new Response(null, { status: 401 });
    retries++;
    assert.equal(url.origin, "https://next.wiz.cn");
    assert.equal(new Headers(init.headers).get("x-wiz-token"), "fresh-token");
    return Response.json({ result: ["ok"] });
  }) });
  assert.deepEqual(await Promise.all([1, 2, 3].map(() => auth.request("/ks/list"))), [["ok"], ["ok"], ["ok"]]);
  assert.equal(refreshes, 1);
  assert.equal(retries, 3);
});

test("rotated credentials survive restart with mode 600 and never cache the password", async t => {
  const config = fixture(t, { userId: "login-user", password: "private-password" });
  const auth = new WizAuthManager(config, { fetch: upstream(() => freshResponse()) });
  await auth.refresh();
  const text = readFileSync(config.sessionPath, "utf8");
  assert.equal(text.includes("private-password"), false);
  assert.equal(text.includes("login-user"), false);
  assert.equal(statSync(config.sessionPath).mode & 0o777, 0o600);
  const restarted = new WizAuthManager(config, { fetch: upstream(() => assert.fail("cache should avoid login")) });
  assert.equal((await restarted.getAccount()).token, "fresh-token");
  assert.equal((await restarted.getAccount()).autoLoginParams, "rotated-auto-secret");
  const changed = new WizAuthManager({ ...config, token: "explicit-new-token" }, { fetch: upstream(() => assert.fail("explicit complete account is ready")) });
  assert.equal((await changed.getAccount()).token, "explicit-new-token");
});

test("network failure preserves the old account and never attempts password login", async t => {
  const calls: string[] = [];
  const auth = new WizAuthManager(fixture(t, { userId: "login-user", password: "private-password" }), { fetch: upstream(url => {
    calls.push(url.pathname);
    throw new Error("network failure containing sensitive details");
  }) });
  await assert.rejects(auth.refresh(), error => error instanceof WizError && error.code === "UPSTREAM_ERROR" && !error.message.includes("sensitive"));
  assert.deepEqual(calls, ["/as/user/login/auto"]);
  assert.equal((await auth.getAccount()).token, "old-token");
});

test("only explicit authentication rejections fall back through token-login to password", async t => {
  const calls: string[] = [];
  const config = fixture(t, { userId: "login-user", password: "private-password" });
  const auth = new WizAuthManager(config, { fetch: upstream((url, init) => {
    calls.push(url.pathname);
    if (url.pathname === "/as/user/login/auto") return Response.json({ returnCode: 2000 });
    if (url.pathname === "/as/user/login/token") return Response.json({ returnCode: 301 });
    assert.equal(url.pathname, "/as/user/login");
    assert.deepEqual(JSON.parse(String(init.body)), { userId: "login-user", password: "private-password", autoLogin: true, deviceId: null, frontLang: "zh-CN" });
    return freshResponse();
  }) });
  assert.equal((await auth.refresh()).token, "fresh-token");
  assert.deepEqual(calls, ["/as/user/login/auto", "/as/user/login/token", "/as/user/login"]);
  assert.equal(readFileSync(config.sessionPath, "utf8").includes("private-password"), false);
});

test("HTTP 403 is permission failure and never triggers renewal", async t => {
  let calls = 0;
  const auth = new WizAuthManager(fixture(t), { fetch: upstream(() => { calls++; return new Response(null, { status: 403 }); }) });
  await assert.rejects(auth.request("/ks/list"), isCode("PERMISSION_DENIED"));
  assert.equal(calls, 1);
});

test("authentication failure on the retried request cannot enter a renewal loop", async t => {
  let calls = 0;
  const auth = new WizAuthManager(fixture(t), { fetch: upstream(url => {
    calls++;
    return url.pathname === "/as/user/login/auto" ? freshResponse() : Response.json({ returnCode: 301 });
  }) });
  await assert.rejects(auth.request("/ks/list"), isCode("AUTH_REQUIRED"));
  assert.equal(calls, 3);
});

test("refuses an unexpected account or knowledge base and preserves the previous identity", async t => {
  for (const patch of [{ userGuid: "other-user" }, { kbGuid: "other-kb" }]) {
    const auth = new WizAuthManager(fixture(t), { fetch: upstream(() => freshResponse(patch)) });
    await assert.rejects(auth.refresh(), isCode("AUTH_REQUIRED"));
    assert.equal((await auth.getAccount()).token, "old-token");
  }
});

test("one request cancellation cannot cancel another request's shared rotation", async t => {
  const controller = new AbortController();
  const auth = new WizAuthManager(fixture(t), { fetch: upstream(async (url, init) => {
    if (url.pathname === "/as/user/login/auto") {
      controller.abort();
      assert.equal(init.signal?.aborted, false);
      await nextTurn();
      return freshResponse();
    }
    return new Headers(init.headers).get("x-wiz-token") === "old-token" ? new Response(null, { status: 401 }) : Response.json({ result: "ok" });
  }) });
  const results = await Promise.allSettled([auth.request("/ks/list", { signal: controller.signal }), auth.request("/ks/list")]);
  assert.equal(results[0].status, "rejected");
  assert.deepEqual(results[1], { status: "fulfilled", value: "ok" });
});

test("start is idempotent, refresh timers never overlap and stop prevents future ticks", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const auth = new WizAuthManager(fixture(t), { fetch: upstream(() => { calls++; return freshResponse(); }) });
  t.after(() => auth.stop());
  auth.start();
  auth.start();
  t.mock.timers.tick(999);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  await nextTurn();
  assert.equal(calls, 2);
  auth.stop();
  t.mock.timers.tick(5000);
  await nextTurn();
  assert.equal(calls, 2);
});

test("restarting during a pending timer renewal cannot create duplicate timer chains", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let complete!: (response: Response) => void;
  const auth = new WizAuthManager(fixture(t), { fetch: upstream(() => {
    calls++;
    return calls === 1 ? new Promise<Response>(resolve => { complete = resolve; }) : freshResponse();
  }) });
  t.after(() => auth.stop());
  auth.start();
  t.mock.timers.tick(1000);
  auth.stop();
  auth.start();
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  complete(freshResponse());
  await nextTurn();
  t.mock.timers.tick(1000);
  await nextTurn();
  assert.equal(calls, 2);
});

test("without a configured server, note requests follow the knowledge server returned by login", async t => {
  const config = fixture(t, { serverUrl: undefined, kbGuid: undefined, userGuid: undefined, autoLoginParams: undefined });
  const auth = new WizAuthManager(config, { fetch: upstream(url => {
    if (url.pathname === "/as/user/login/token") {
      assert.equal(url.origin, "https://as.wiz.cn");
      return freshResponse({ kbServer: "https://next.wiz.cn" });
    }
    assert.equal(url.origin, "https://next.wiz.cn");
    return Response.json({ result: "ok" });
  }) });
  assert.equal(await auth.request("/ks/list"), "ok");
});

test("a configured server is used for login, then note requests use the returned knowledge server", async t => {
  const config = fixture(t, {
    serverUrl: "http://notes.example.com:8080",
    token: undefined, kbGuid: undefined, userGuid: undefined, autoLoginParams: undefined,
    userId: "login-user", password: "private-password",
  });
  const origins: string[] = [];
  const auth = new WizAuthManager(config, { fetch: upstream(url => {
    origins.push(`${url.origin}${url.pathname}`);
    if (url.pathname === "/as/user/login") return freshResponse({ kbServer: "http://kb.internal:9090" });
    return Response.json({ result: "ok" });
  }) });
  assert.equal((await auth.getAccount()).kbServer, "http://kb.internal:9090");
  assert.equal(await auth.request("/ks/list"), "ok");
  assert.deepEqual(origins, ["http://notes.example.com:8080/as/user/login", "http://kb.internal:9090/ks/list"]);
});

test("unsafe servers and absolute interface paths never receive credentials", async t => {
  assert.throws(() => new WizAuthManager(fixture(t, { serverUrl: "https://private@attacker.example" })), isCode("INVALID_CONFIG"));
  const auth = new WizAuthManager(fixture(t), { fetch: upstream(() => assert.fail("must not send credentials")) });
  for (const path of ["https://attacker.example", "//attacker.example", "/ks/../as/login", "/ks/list?token=secret"]) await assert.rejects(auth.request(path), isCode("INVALID_INPUT"));
});
