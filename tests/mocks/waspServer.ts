/** 只实现 operations.ts 单元测试需要的 HttpError 行为。 */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message?: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
