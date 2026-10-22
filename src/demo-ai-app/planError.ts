export type PlanErrorCode =
  | "AUTH_REQUIRED"
  | "INVALID_INPUT"
  | "NO_AVAILABLE_CREDIT"
  | "PROVIDER_FAILED"
  | "SAVE_FAILED"
  | "DB_UNAVAILABLE"
  | "OUTCOME_UNKNOWN";

export class PlanError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: PlanErrorCode,
    message: string,
    public readonly attemptId?: string,
  ) {
    super(message);
    this.name = "PlanError";
  }
}
