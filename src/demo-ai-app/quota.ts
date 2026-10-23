import { Prisma, type PrismaClient } from "@prisma/client";
import type { GeneratedSchedule } from "./schedule";

type Database = Pick<PrismaClient, "user" | "planResult">;

export class QuotaError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export async function generateWithQuota(
  db: Database,
  userId: string,
  generate: () => Promise<GeneratedSchedule | null>,
): Promise<GeneratedSchedule> {
  // The database predicate is the only admission gate, including concurrent requests.
  const reserved = await db.user.updateMany({
    where: { id: userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
  if (reserved.count !== 1) {
    throw new QuotaError(402, "额度不足。请刷新查看余额，或等待正在处理的请求结束。");
  }

  const refund = async () => {
    try {
      await db.user.update({ where: { id: userId }, data: { credits: { increment: 1 } } });
    } catch (error) {
      console.error("quota.refund-failed", { userId, error });
      throw new QuotaError(503, "生成失败，额度返还未确认。请联系管理员核查，暂勿重试。");
    }
  };

  let schedule: GeneratedSchedule;
  try {
    const result = await generate();
    if (result === null) throw new Error("Provider returned no result");
    schedule = result;
  } catch {
    await refund();
    throw new QuotaError(502, "生成失败，额度已返还。请删除包含 [fail] 的任务后重试。");
  }

  try {
    await db.planResult.create({ data: { userId, content: JSON.stringify(schedule) } });
  } catch (error) {
    // Only confirmed statement rejection is safe to compensate. A lost connection
    // may hide a committed write, so unknown outcomes require manual reconciliation.
    if (error instanceof Prisma.PrismaClientKnownRequestError &&
      ["P2000", "P2002", "P2003", "P2011", "P2012", "P2014", "P2025"].includes(error.code)) {
      await refund();
      throw new QuotaError(503, "结果保存失败，额度已返还。请稍后重试。");
    }
    console.error("quota.save-unconfirmed", { userId, error });
    throw new QuotaError(503, "结果保存状态待核查。请刷新查看历史日程，联系管理员后再重试。");
  }
  return schedule;
}
