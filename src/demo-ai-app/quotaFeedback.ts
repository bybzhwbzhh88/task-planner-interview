type ErrorBody = { message?: string; data?: { code?: string; requestId?: string } };
const knownCodes = new Set(["AUTH_REQUIRED", "INVALID_INPUT", "NO_TASKS", "QUOTA_EXHAUSTED", "PROVIDER_FAILED", "RESULT_SAVE_FAILED", "RESERVATION_FAILED"]);

export function quotaFeedback(error: unknown) {
  // Wasp 0.25's client puts the complete HTTP body in error.data.
  const body = error && typeof error === "object" && "data" in error ? error.data as ErrorBody | undefined : undefined;
  const code = body?.data?.code;
  const requestId = typeof body?.data?.requestId === "string" ? body.data.requestId : undefined;
  const message = code && knownCodes.has(code) && typeof body?.message === "string"
    ? body.message
    : "生成结果暂未确认，请先刷新额度与最近结果，再决定是否重试。";
  return { code, requestId, message };
}
