import type { GeneratedSchedule } from "./schedule";

/**
 * Framework-agnostic quota orchestration.
 *
 * The important ordering is:
 *   1. atomically reserve one credit in the database,
 *   2. only then call the model,
 *   3. refund the reservation if no usable result is delivered.
 *
 * Keeping this module free of Wasp/Prisma imports lets the quota state machine
 * be tested with an in-memory repository, including interleaved requests.
 */

export type PlanTask = {
  description: string;
  time: string;
};

export type CreditReservation =
  | { ok: true; remainingCredits: number }
  | { ok: false; remainingCredits: number };

export type PlanRepository = {
  listTasks(userId: string): Promise<PlanTask[]>;
  reserveCredit(userId: string): Promise<CreditReservation>;
  refundCredit(userId: string): Promise<void>;
  savePlanResult(userId: string, content: string): Promise<void>;
};

export type ScheduleGenerator = (
  tasks: PlanTask[],
  hours: number,
) => Promise<GeneratedSchedule>;

export type GeneratePlanResult = {
  schedule: GeneratedSchedule;
  remainingCredits: number;
};

export const MODEL_REJECTED_CODE = "MOCK_AI_REJECTED";

export class InsufficientCreditsError extends Error {
  readonly code = "INSUFFICIENT_CREDITS";
  readonly statusCode = 402;
  readonly remainingCredits: number;

  constructor(remainingCredits: number) {
    super(`Insufficient credits (remaining: ${remainingCredits})`);
    this.name = "InsufficientCreditsError";
    this.remainingCredits = remainingCredits;
  }
}

export class ModelRejectedError extends Error {
  readonly code = "MODEL_REJECTED";
  readonly statusCode = 502;
  readonly providerError: unknown;

  constructor(providerError: unknown) {
    super("The model provider explicitly rejected the request", {
      cause: providerError,
    });
    this.name = "ModelRejectedError";
    this.providerError = providerError;
  }
}

export class CreditRefundError extends Error {
  readonly code = "CREDIT_REFUND_FAILED";
  readonly statusCode = 500;
  readonly originalError: unknown;
  readonly refundError: unknown;

  constructor(originalError: unknown, refundError: unknown) {
    super("The generation failed and the reserved credit could not be refunded", {
      cause: refundError,
    });
    this.name = "CreditRefundError";
    this.originalError = originalError;
    this.refundError = refundError;
  }
}

/** Duck-typed so this module does not need to import the provider at runtime. */
export function isModelRejection(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === MODEL_REJECTED_CODE
  );
}

export async function generatePlanWithQuota(
  input: { userId: string; hours: number },
  deps: { repo: PlanRepository; generateSchedule: ScheduleGenerator },
): Promise<GeneratePlanResult> {
  const reservation = await deps.repo.reserveCredit(input.userId);
  if (!reservation.ok) {
    // No model call happens on this path.
    throw new InsufficientCreditsError(reservation.remainingCredits);
  }

  try {
    const tasks = await deps.repo.listTasks(input.userId);
    const schedule = await deps.generateSchedule(tasks, input.hours);
    if (!schedule) {
      throw new Error("The model returned no schedule");
    }
    await deps.repo.savePlanResult(input.userId, JSON.stringify(schedule));
    return {
      schedule,
      remainingCredits: reservation.remainingCredits,
    };
  } catch (error) {
    try {
      await deps.repo.refundCredit(input.userId);
    } catch (refundError) {
      // Surfacing this separately matters: the user may have paid for a failure.
      throw new CreditRefundError(error, refundError);
    }

    if (isModelRejection(error)) {
      throw new ModelRejectedError(error);
    }
    throw error;
  }
}
