import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import type { AuthConfig } from "./auth.js";
import { WizError } from "./errors.js";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export function loadEnvironment() {
  const index = process.argv.indexOf("--env-file");
  const path = index >= 0 ? process.argv[index + 1] : resolve(projectRoot, ".env");
  if (index >= 0 && !path) throw new WizError("INVALID_CONFIG", "--env-file 后需要指定配置文件路径。");
  if (path && existsSync(path)) loadEnvFile(path);
  else if (index >= 0) throw new WizError("INVALID_CONFIG", "指定的配置文件不存在。");
}

export interface ServiceConfig {
  host: string;
  port: number;
  bearerToken?: string;
  journalPath: string;
  keepWriteJournal: boolean;
  timeoutMs: number;
  maxConcurrent: number;
  auth: AuthConfig;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new WizError("INVALID_CONFIG", `${key} 配置无效。`);
    return value;
  };
  if (Boolean(env.WIZ_USER_ID) !== Boolean(env.WIZ_PASSWORD)) throw new WizError("INVALID_CONFIG", "WIZ_USER_ID 和 WIZ_PASSWORD 必须同时配置。");
  if (!env.WIZ_TOKEN && !env.WIZ_AUTO_LOGIN_PARAMS && !env.WIZ_USER_ID) throw new WizError("INVALID_CONFIG", "请配置为知账号密码、已有 token 或自动登录凭据。");
  const host = env.MCP_HOST || "127.0.0.1";
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(host);
  if (!loopback && !env.MCP_AUTH_TOKEN) throw new WizError("INVALID_CONFIG", "对外监听时请配置 MCP_AUTH_TOKEN。");
  const flag = (key: string, fallback: boolean) => {
    const value = env[key]?.trim().toLowerCase();
    if (value === undefined || value === "") return fallback;
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
    throw new WizError("INVALID_CONFIG", `${key} 配置无效。`);
  };
  const timeoutMs = integer("WIZ_TIMEOUT_MS", 30_000, 1_000, 120_000);
  return {
    host,
    port: integer("MCP_PORT", 8790, 1, 65535),
    bearerToken: env.MCP_AUTH_TOKEN || undefined,
    journalPath: resolve(projectRoot, env.WIZ_JOURNAL_PATH || ".data/writes"),
    keepWriteJournal: flag("WIZ_KEEP_WRITE_JOURNAL", false),
    timeoutMs,
    maxConcurrent: integer("WIZ_MAX_CONCURRENT", 8, 1, 64),
    auth: {
      userId: env.WIZ_USER_ID || undefined,
      password: env.WIZ_PASSWORD || undefined,
      token: env.WIZ_TOKEN || undefined,
      autoLoginParams: env.WIZ_AUTO_LOGIN_PARAMS || undefined,
      serverUrl: env.WIZ_SERVER_URL || undefined,
      kbGuid: env.WIZ_KB_GUID || undefined,
      userGuid: env.WIZ_USER_GUID || undefined,
      sessionPath: resolve(projectRoot, env.WIZ_SESSION_PATH || ".data/session.json"),
      refreshIntervalMs: integer("WIZ_REFRESH_INTERVAL_SECONDS", 1800, 10, 86400) * 1000,
      timeoutMs,
    },
  };
}
