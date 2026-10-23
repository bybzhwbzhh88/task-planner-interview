/**
 * Per-request credit reservation. A single conditional SQL UPDATE prevents
 * overdrafts, even when several HTTP requests run in different processes.
 *
 * No transaction/row lock is held while the mock provider executes. A
 * successful save finalizes the reservation; a failure returns the credit.
 * Crash recovery for an in-flight reservation is explicitly out of scope.
 */
export type QuotaErrorCode =
  | "CREDITS_EXHAUSTED"
  | "CREDIT_CHECK_FAILED"
  | "GENERATION_FAILED"
  | "PERSISTENCE_FAILED"
  | "CREDIT_REFUND_FAILED";

export class QuotaError extends Error {
  readonly code: QuotaErrorCode;

  constructor(
    code: QuotaErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "QuotaError";
    this.code = code;
  }
}

export interface CreditStore {
  /** Return false if and only if no credit was reserved. */
  reserve(userId: string): Promise<boolean>;
  /** Release exactly one credit reserved by this request. */
  release(userId: string): Promise<void>;
}

// Minimal Prisma delegate contract: this can be unit-tested without Wasp.
export interface PrismaUserCreditsDelegate {
  updateMany(args: {
    where: { id: string; credits: { gt: number } };
    data: { credits: { decrement: number } };
  }): PromiseLike<{ count: number }>;
  update(args: {
    where: { id: string };
    data: { credits: { increment: number } };
  }): PromiseLike<unknown>;
}

export function createPrismaCreditStore(
  user: PrismaUserCreditsDelegate,
): CreditStore {
  return {
    async reserve(userId) {
      // WHERE credits > 0 and decrement happen in ONE atomic PostgreSQL UPDATE.
      const { count } = await user.updateMany({
        where: { id: userId, credits: { gt: 0 } },
        data: { credits: { decrement: 1 } },
      });
      if (count !== 0 && count !== 1) {
        throw new Error(`Unexpected quota update count: ${count}`);
      }
      return count === 1;
    },
    async release(userId) {
      await user.update({
        where: { id: userId },
        data: { credits: { increment: 1 } },
      });
    },
  };
}

async function releaseAfterFailure(
  store: CreditStore,
  userId: string,
  stage: "GENERATION_FAILED" | "PERSISTENCE_FAILED",
  originalError: unknown,
): Promise<never> {
  try {
    await store.release(userId);
  } catch (refundError) {
    // Outcome is unknown: never promise that a credit was returned.
    throw new QuotaError(
      "CREDIT_REFUND_FAILED",
      "日程未完成，额度返还未确认，请联系管理员核对。",
      { originalError, refundError },
    );
  }
  throw new QuotaError(
    stage,
    stage === "GENERATION_FAILED"
      ? "日程生成失败，额度已返还，请检查任务后重试。"
      : "日程保存失败，额度已返还，请稍后重试。",
    originalError,
  );
}

export async function executeWithQuota<Generated>(options: {
  store: CreditStore;
  userId: string;
  generate(): Promise<Generated>;
  save(result: Generated): Promise<void>;
}): Promise<Generated> {
  const { store, userId, generate, save } = options;
  if (!userId) throw new Error("Authenticated user ID is required");

  let reserved: boolean;
  try {
    reserved = await store.reserve(userId);
  } catch (error) {
    throw new QuotaError("CREDIT_CHECK_FAILED", "额度检查失败，请稍后重试。", error);
  }
  if (!reserved) {
    throw new QuotaError("CREDITS_EXHAUSTED", "额度不足，当前无法生成日程。");
  }

  let result: Generated;
  try {
    result = await generate();
    // The local mock rejects on explicit failure; null is also not a valid plan.
    if (result == null) throw new Error("Provider returned an empty result");
  } catch (error) {
    return releaseAfterFailure(store, userId, "GENERATION_FAILED", error);
  }

  try {
    await save(result);
  } catch (error) {
    return releaseAfterFailure(store, userId, "PERSISTENCE_FAILED", error);
  }
  return result;
}
