export class WizError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "WizError";
  }
}

export function safeError(error: unknown) {
  return error instanceof WizError
    ? { code: error.code, message: error.message, ...error.details }
    : { code: "UPSTREAM_ERROR", message: "请求失败，请检查网络和服务配置后重试。" };
}
