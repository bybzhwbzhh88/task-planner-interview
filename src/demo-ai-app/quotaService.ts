import { Prisma, type PrismaClient } from "@prisma/client";
import { generatedScheduleSchema, type GeneratedSchedule } from "./schedule";
import { PlanError } from "./planError";

export type TransactionPhase = "reserve" | "confirm" | "release";
type Tx = Prisma.TransactionClient;
export type Settlement =
  | { status: "SUCCEEDED"; schedule: GeneratedSchedule }
  | { status: "RELEASED" }
  | { status: "MISSING" };

// Internal injection points exercise real transaction rollback / lost commit replies.
// They are never selected by HTTP input or environment flags.
export interface QuotaHooks {
  insideTransaction?: (phase: TransactionPhase, tx: Tx) => Promise<void>;
  afterCommit?: (phase: TransactionPhase) => Promise<void>;
  beforeTransaction?: (phase: TransactionPhase) => Promise<void>;
}

export class TransactionFailure extends Error {
  constructor(public readonly rollbackConfirmed: boolean, cause: unknown) {
    super("Quota transaction did not return a confirmed outcome", { cause });
    this.name = "TransactionFailure";
  }
}

export function createQuotaService(db: PrismaClient, hooks: QuotaHooks = {}) {
  async function transaction<T>(
    phase: TransactionPhase,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    let callbackError: unknown;
    try {
      await hooks.beforeTransaction?.(phase);
      const result = await db.$transaction(async (tx) => {
        try {
          return await work(tx);
        } catch (error) {
          callbackError = error;
          throw error;
        }
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 5000,
        timeout: 5000,
      });
      await hooks.afterCommit?.(phase);
      return result;
    } catch (error) {
      // A callback error propagated by $transaction has completed its rollback.
      // An error after the callback/commit has no such guarantee.
      throw new TransactionFailure(callbackError !== undefined && error === callbackError, error);
    }
  }

  async function readSettlement(tx: Tx, userId: string, id: string): Promise<Settlement> {
    const attempt = await tx.generationAttempt.findFirst({
      where: { id, userId },
      include: { result: true },
    });
    if (!attempt) return { status: "MISSING" };
    if (attempt.status === "RELEASED") return { status: "RELEASED" };
    if (attempt.status !== "SUCCEEDED" || !attempt.result || attempt.result.userId !== userId) {
      throw new Error("Attempt has no consistent terminal result");
    }
    return {
      status: "SUCCEEDED",
      schedule: generatedScheduleSchema.parse(JSON.parse(attempt.result.content)),
    };
  }

  return {
    async reserve(userId: string, id: string): Promise<void> {
      try {
        await transaction("reserve", async (tx) => {
          const changed = await tx.user.updateMany({
            where: { id: userId, credits: { gte: 1 } },
            data: { credits: { decrement: 1 } },
          });
          if (changed.count !== 1) {
            throw new PlanError(402, "NO_AVAILABLE_CREDIT", "当前没有可用额度；若其他页面正在生成，请完成后刷新。");
          }
          await hooks.insideTransaction?.("reserve", tx);
          await tx.generationAttempt.create({ data: { id, userId } });
        });
      } catch (error) {
        if (error instanceof TransactionFailure && error.rollbackConfirmed && error.cause instanceof PlanError) {
          throw error.cause;
        }
        throw error;
      }
    },

    async confirm(userId: string, id: string, content: string): Promise<Settlement> {
      return transaction("confirm", async (tx) => {
        const changed = await tx.generationAttempt.updateMany({
          where: { id, userId, status: "RESERVED" },
          data: { status: "SUCCEEDED" },
        });
        if (changed.count !== 1) return readSettlement(tx, userId, id);
        await hooks.insideTransaction?.("confirm", tx);
        const result = await tx.planResult.create({
          data: { userId, content, generationAttemptId: id },
        });
        return {
          status: "SUCCEEDED",
          schedule: generatedScheduleSchema.parse(JSON.parse(result.content)),
        };
      });
    },

    async release(userId: string, id: string): Promise<Settlement> {
      return transaction("release", async (tx) => {
        const changed = await tx.generationAttempt.updateMany({
          where: { id, userId, status: "RESERVED" },
          data: { status: "RELEASED" },
        });
        if (changed.count !== 1) return readSettlement(tx, userId, id);
        await hooks.insideTransaction?.("release", tx);
        await tx.user.update({
          where: { id: userId },
          data: { credits: { increment: 1 } },
        });
        return { status: "RELEASED" };
      });
    },
  };
}

export type QuotaService = ReturnType<typeof createQuotaService>;
