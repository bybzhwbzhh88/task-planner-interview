import { Prisma, type PrismaClient } from "@prisma/client";
import * as z from "zod";
import type { GeneratedSchedule } from "./schedule";

export type ProviderTask = { description: string; time: string };
export type QuotaStore = {
  loadTasks(userId: string): Promise<ProviderTask[]>;
  reserve(userId: string): Promise<boolean>;
  refund(userId: string): Promise<void>;
  save(userId: string, schedule: GeneratedSchedule): Promise<void>;
};

// Only an explicit rejection is safe to refund. Unknown outcomes require review.
export class ProviderRejectedError extends Error {}
export class SaveRejectedError extends Error {}
export class QuotaError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const planInputSchema = z.object({ hours: z.number() });

export async function generatePlanWithQuota(
  rawArgs: unknown,
  user: { id: string } | undefined,
  deps: {
    store: QuotaStore;
    provider(tasks: ProviderTask[], hours: number): Promise<GeneratedSchedule>;
  },
): Promise<GeneratedSchedule> {
  if (!user) throw new QuotaError(401, "AUTH_REQUIRED", "请登录后生成日程。");
  const input = planInputSchema.safeParse(rawArgs);
  if (!input.success) throw new QuotaError(400, "INVALID_INPUT", "可用时长须为数值。");
  const { store, provider } = deps;
  let tasks: ProviderTask[];
  try { tasks = await store.loadTasks(user.id); } catch {
    throw new QuotaError(503, "TASKS_UNAVAILABLE", "任务读取失败，本次未扣额度，请稍后重试。");
  }
  if (!tasks.length) throw new QuotaError(400, "NO_TASKS", "请先添加待办事项，本次未扣额度。");
  let reserved: boolean;
  try { reserved = await store.reserve(user.id); } catch {
    throw new QuotaError(503, "OUTCOME_UNKNOWN", "额度状态暂无法确认，请先刷新额度，勿立即重复生成。");
  }
  if (!reserved) throw new QuotaError(402, "NO_CREDITS", "暂无可用额度；若其他页面正在生成，请等待结束后刷新额度。");

  async function refund(code: string, message: string): Promise<never> {
    try { await store.refund(user!.id); } catch {
      throw new QuotaError(503, "REFUND_UNKNOWN", "生成失败，但额度退回状态暂无法确认。请刷新额度后联系维护者核查。");
    }
    throw new QuotaError(502, code, message);
  }

  let schedule: GeneratedSchedule;
  try { schedule = await provider(tasks, input.data.hours); } catch (error) {
    if (error instanceof ProviderRejectedError) {
      return refund("PROVIDER_FAILED", "模型明确生成失败，预扣额度已退回。请移除包含 [fail] 的任务后重试。");
    }
    throw new QuotaError(503, "OUTCOME_UNKNOWN", "生成结果暂无法确认，请先刷新额度，勿立即重复生成。");
  }
  try { await store.save(user.id, schedule); } catch (error) {
    if (error instanceof SaveRejectedError) {
      return refund("SAVE_FAILED", "日程保存明确失败，预扣额度已退回，请稍后重试。");
    }
    throw new QuotaError(503, "OUTCOME_UNKNOWN", "日程保存结果暂无法确认，请先刷新额度，勿立即重复生成。");
  }
  return schedule;
}

export function createQuotaStore(db: PrismaClient): QuotaStore {
  return {
    loadTasks: (userId) => db.task.findMany({ where: { userId }, select: { description: true, time: true } }),
    async reserve(userId) {
      // PostgreSQL evaluates the balance guard and debit in ONE statement.
      // A waiting UPDATE rechecks this condition against the committed row.
      const result = await db.user.updateMany({
        where: { id: userId, credits: { gt: 0 } },
        data: { credits: { decrement: 1 } },
      });
      return result.count === 1;
    },
    async refund(userId) {
      const result = await db.user.updateMany({ where: { id: userId }, data: { credits: { increment: 1 } } });
      if (result.count !== 1) throw new Error("Refund recipient no longer exists");
    },
    async save(userId, schedule) {
      try {
        await db.planResult.create({ data: { userId, content: JSON.stringify(schedule) } });
      } catch (error) {
        // These statement rejections confirm that this INSERT did not commit.
        // Connection errors and lost replies must not create a free saved plan.
        if (error instanceof Prisma.PrismaClientKnownRequestError &&
          ["P2000", "P2002", "P2003", "P2011", "P2012", "P2014", "P2025"].includes(error.code)) {
          throw new SaveRejectedError("Database explicitly rejected the result", { cause: error });
        }
        throw error;
      }
    },
  };
}
