import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WizError } from "./errors.js";

export interface AuthConfig {
  userId?: string;
  password?: string;
  token?: string;
  autoLoginParams?: string;
  serverUrl?: string;
  kbGuid?: string;
  userGuid?: string;
  sessionPath: string;
  refreshIntervalMs: number;
  timeoutMs: number;
}

export interface Account {
  kbServer: string;
  kbGuid: string;
  userGuid: string;
  token: string;
  /** 登录名，通常是邮箱或手机号。笔记元信息的 owner 用它，不用 userGuid。 */
  userId?: string;
  autoLoginParams?: string;
  displayName?: string;
}

type RecordValue = Record<string, unknown>;
export interface WizRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}
const clientParams = { clientType: "Desktop-mac", plat: "Desktop-mac", clientVersion: "0.1.107" };
const asOrigin = "https://as.wiz.cn";
const authError = () => new WizError("AUTH_REQUIRED", "为知账号授权已失效，请更新服务端登录配置。");
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};

function safeOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && (url.hostname === "wiz.cn" || url.hostname.endsWith(".wiz.cn")) && !url.username && !url.password && !url.port) return url.origin;
  } catch { /* Never expose the rejected URL, which may contain credentials. */ }
  throw new WizError("INVALID_CONFIG", "为知知识库服务器必须是无凭证的 HTTPS wiz.cn 地址。");
}

function accountFrom(value: unknown, previousParams?: string): Account {
  const envelope = record(value);
  const result = record(envelope.result ?? value);
  if (![result.kbGuid, result.userGuid].every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)) || typeof result.token !== "string" || !result.token || typeof result.kbServer !== "string") {
    throw new WizError("UPSTREAM_ERROR", "为知登录响应缺少有效账号信息。");
  }
  const params = envelope.wizAutoLoginParams ?? result.wizAutoLoginParams ?? result.autoLoginParams ?? previousParams;
  const userId = loginId(result.userId) ?? loginId(result.email);
  return {
    kbGuid: result.kbGuid as string,
    userGuid: result.userGuid as string,
    token: result.token,
    kbServer: safeOrigin(result.kbServer),
    ...(userId ? { userId } : {}),
    ...(typeof params === "string" && params ? { autoLoginParams: params } : {}),
    ...(typeof result.displayName === "string" ? { displayName: result.displayName } : {}),
  };
}

function loginId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || id.length > 320 || /[\u0000-\u001f]/.test(id)) return undefined;
  return id;
}

/** Owns one account session. Neither passwords nor tokens are returned by MCP tools. */
export class WizAuthManager {
  private readonly config: AuthConfig;
  private readonly fetcher: typeof fetch;
  private readonly seed: string;
  private account?: Account;
  private renewal?: Promise<Account>;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private timerGeneration = 0;

  constructor(config: AuthConfig, options: { fetch?: typeof fetch } = {}) {
    if (!config.token && !config.autoLoginParams && !(config.userId && config.password)) throw new WizError("INVALID_CONFIG", "请配置为知 token、自动登录凭证或账号密码。");
    if (!config.sessionPath || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || !Number.isSafeInteger(config.refreshIntervalMs) || config.refreshIntervalMs < 1) throw new WizError("INVALID_CONFIG", "登录缓存路径或刷新时间配置无效。");
    for (const id of [config.kbGuid, config.userGuid]) if (id !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new WizError("INVALID_CONFIG", "知识库或用户标识无效。");
    this.config = { ...config, ...(config.serverUrl ? { serverUrl: safeOrigin(config.serverUrl) } : {}) };
    this.fetcher = options.fetch ?? globalThis.fetch;
    // A credential/configuration change intentionally invalidates the old cache.
    // Only this digest is written; the password itself is never cached.
    this.seed = createHash("sha256").update(JSON.stringify({ ...this.config, sessionPath: undefined, refreshIntervalMs: undefined, timeoutMs: undefined })).digest("hex");
    if (config.token && config.userGuid && config.kbGuid && this.config.serverUrl) {
      this.account = { token: config.token, userGuid: config.userGuid, kbGuid: config.kbGuid, kbServer: this.config.serverUrl, ...(config.autoLoginParams ? { autoLoginParams: config.autoLoginParams } : {}) };
    }
    try {
      const saved = record(JSON.parse(readFileSync(config.sessionPath, "utf8")));
      if (saved.seed === this.seed) {
        const account = accountFrom(saved.account);
        this.checkIdentity(account);
        this.account = account;
        chmodSync(config.sessionPath, 0o600);
      }
    } catch { /* Missing, corrupt, mismatched or unsafe cache: use explicit config. */ }
  }

  /** Configured login id fills owner only in memory. The session file keeps the server value. */
  private present(account: Account): Account {
    if (account.userId || !this.config.userId) return { ...account };
    return { ...account, userId: this.config.userId };
  }

  private checkIdentity(next: Account) {
    const userGuid = this.account?.userGuid ?? this.config.userGuid;
    const kbGuid = this.account?.kbGuid ?? this.config.kbGuid;
    if ((userGuid && next.userGuid !== userGuid) || (kbGuid && next.kbGuid !== kbGuid)) throw new WizError("AUTH_REQUIRED", "登录返回了不同账号或知识库，已拒绝替换会话。");
  }

  private persist(next: Account) {
    this.checkIdentity(next);
    const directory = dirname(this.config.sessionPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.config.sessionPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ seed: this.seed, account: next }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.config.sessionPath);
    } catch {
      throw new WizError("SESSION_STORE_ERROR", "无法保存为知登录会话，请检查缓存目录权限。");
    } finally { rmSync(temporary, { force: true }); }
    this.account = next;
  }

  private async send(origin: string, path: string, options: WizRequestOptions & { headers?: Record<string, string> } = {}): Promise<unknown> {
    const url = new URL(path, safeOrigin(origin));
    for (const [name, value] of Object.entries({ ...clientParams, ...options.query })) url.searchParams.set(name, value);
    let response: Response;
    let envelope: unknown;
    try {
      const timeout = AbortSignal.timeout(this.config.timeoutMs);
      response = await this.fetcher(url, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers: { Accept: "application/json", ...options.headers, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: "error",
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
      // Status/header authentication errors remain classifiable without a JSON body.
      if (response.status === 401 || response.headers.get("x-wiz-code") === "301") throw authError();
      if (response.status === 403) throw new WizError("PERMISSION_DENIED", "为知拒绝此请求，账号可能没有访问权限。");
      if (response.status === 404) throw new WizError("NOT_FOUND", "为知文章或接口不存在。");
      if (!response.ok) throw new WizError("UPSTREAM_ERROR", "为知请求失败，请稍后重试。");
      envelope = await response.json();
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof WizError) throw error;
      throw new WizError("UPSTREAM_ERROR", "暂时无法连接为知服务，请稍后重试。");
    }
    const data = record(envelope);
    const code = data.returnCode ?? data.return_code;
    if (code !== undefined && Number(code) !== 200) {
      if (Number(code) === 301 || (path === "/as/user/login/auto" && Number(code) === 2000)) throw authError();
      if (Number(code) === 2004) throw new WizError("NOT_FOUND", "为知文章不存在或已删除。");
      throw new WizError("UPSTREAM_ERROR", "为知未能完成请求，请稍后重试。");
    }
    return envelope;
  }

  private async performRefresh(): Promise<Account> {
    const previous = this.account;
    const params = previous?.autoLoginParams ?? this.config.autoLoginParams;
    const token = previous?.token ?? this.config.token;
    const candidates: Array<() => Promise<unknown>> = [];
    if (params) candidates.push(() => this.send(asOrigin, "/as/user/login/auto", { headers: { "wiz-auto-login-param": params } }));
    if (token) candidates.push(() => this.send(asOrigin, "/as/user/login/token", { method: "POST", query: { token } }));
    if (this.config.userId && this.config.password) candidates.push(() => this.send(asOrigin, "/as/user/login", {
      method: "POST", body: { userId: this.config.userId, password: this.config.password, autoLogin: true, deviceId: null, frontLang: "zh-CN" },
    }));
    for (const candidate of candidates) {
      let envelope: unknown;
      try { envelope = await candidate(); }
      catch (error) {
        // Auth rejection permits the next authentication method; network and
        // permission failures preserve the existing account without password login.
        if (error instanceof WizError && error.code === "AUTH_REQUIRED") continue;
        throw error;
      }
      const next = accountFrom(envelope, params);
      this.checkIdentity(next);
      this.persist(next);
      return { ...next };
    }
    throw authError();
  }

  async refresh(): Promise<Account> {
    if (!this.renewal) this.renewal = this.performRefresh();
    const pending = this.renewal;
    try { return this.present(await pending); }
    finally { if (this.renewal === pending) this.renewal = undefined; }
  }

  async getAccount(signal?: AbortSignal): Promise<Account> {
    signal?.throwIfAborted();
    const account = this.account ?? await this.refresh();
    signal?.throwIfAborted();
    return this.present(account);
  }

  async request<T = unknown>(path: string, options: WizRequestOptions = {}): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//") || /[?#\\]/.test(path) || path.split("/").includes("..")) throw new WizError("INVALID_INPUT", "为知接口路径无效。");
    const account = await this.getAccount(options.signal);
    const send = async (current: Account) => {
      const data = await this.send(current.kbServer, path, { ...options, headers: { "x-wiz-token": current.token } });
      return (Object.hasOwn(record(data), "result") ? record(data).result : data) as T;
    };
    try { return await send(account); }
    catch (error) {
      if (!(error instanceof WizError) || error.code !== "AUTH_REQUIRED") throw error;
      options.signal?.throwIfAborted();
      // Requests that failed on an old token reuse a completed rotation.
      const next = this.account?.token !== account.token ? await this.getAccount(options.signal) : await this.refresh();
      options.signal?.throwIfAborted();
      return send(next);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.timerGeneration;
    const schedule = () => {
      if (!this.running || generation !== this.timerGeneration) return;
      this.timer = setTimeout(async () => {
        this.timer = undefined;
        try { await this.refresh(); } catch { /* Retain the old session; request retries still report errors. */ }
        schedule();
      }, this.config.refreshIntervalMs);
      this.timer.unref();
    };
    schedule();
  }

  stop(): void {
    this.running = false;
    this.timerGeneration++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
