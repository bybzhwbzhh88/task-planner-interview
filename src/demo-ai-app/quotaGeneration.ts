import type { GeneratedSchedule } from "./schedule";

export type QuotaGenerationTask = {
  description: string;
  time: string;
};

export type QuotaGenerationErrorKind =
  | "insufficient-credits"
  | "provider-failed"
  | "persistence-failed"
  | "refund-failed";

export class QuotaGenerationError extends Error {
  constructor(
    public readonly kind: QuotaGenerationErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "QuotaGenerationError";
  }
}

export interface QuotaGenerationStore {
  reserveCredit(userId: string): Promise<boolean>;
  refundCredit(userId: string): Promise<number>;
  saveResultAndGetBalance(
    userId: string,
    schedule: GeneratedSchedule,
  ): Promise<number>;
}

export interface QuotaGenerationLogger {
  info(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

type GenerateSchedule = (
  tasks: QuotaGenerationTask[],
  hours: number,
) => Promise<GeneratedSchedule>;

type GenerateScheduleWithQuotaArgs = {
  userId: string;
  tasks: QuotaGenerationTask[];
  hours: number;
  store: QuotaGenerationStore;
  generateSchedule: GenerateSchedule;
  logger?: QuotaGenerationLogger;
};

function logSafely(
  logger: QuotaGenerationLogger,
  level: "info" | "error",
  message: string,
  details: Record<string, unknown>,
) {
  try {
    logger[level](message, details);
  } catch {
    // Logging must not change the quota transaction outcome.
  }
}

export type QuotaGenerationResult = {
  schedule: GeneratedSchedule;
  creditsRemaining: number;
};

export async function generateScheduleWithQuota({
  userId,
  tasks,
  hours,
  store,
  generateSchedule,
  logger = console,
}: GenerateScheduleWithQuotaArgs): Promise<QuotaGenerationResult> {
  const reserved = await store.reserveCredit(userId);
  if (!reserved) {
    throw new QuotaGenerationError(
      "insufficient-credits",
      "No credits are available for this generation.",
    );
  }

  let reservationOpen = true;
  let phase: "provider" | "persistence" = "provider";

  try {
    const schedule = await generateSchedule(tasks, hours);
    phase = "persistence";
    const creditsRemaining = await store.saveResultAndGetBalance(
      userId,
      schedule,
    );
    reservationOpen = false;
    logSafely(logger, "info", "quota.generation.succeeded", {
      userId,
      creditsRemaining,
    });
    return { schedule, creditsRemaining };
  } catch (error) {
    if (reservationOpen) {
      try {
        const creditsRemaining = await store.refundCredit(userId);
        reservationOpen = false;
        logSafely(logger, "info", "credit.refunded", {
          userId,
          phase,
          creditsRemaining,
        });
      } catch (refundError) {
        logSafely(logger, "error", "credit.refund_failed", {
          userId,
          phase,
          cause:
            refundError instanceof Error
              ? refundError.message
              : String(refundError),
          originalError:
            error instanceof Error ? error.message : String(error),
        });
        throw new QuotaGenerationError(
          "refund-failed",
          "The reserved credit could not be refunded.",
          { cause: refundError },
        );
      }
    }

    if (phase === "provider") {
      throw new QuotaGenerationError(
        "provider-failed",
        "The mock provider rejected the generation request.",
        { cause: error },
      );
    }

    throw new QuotaGenerationError(
      "persistence-failed",
      "The generated schedule could not be saved.",
      { cause: error },
    );
  }
}
