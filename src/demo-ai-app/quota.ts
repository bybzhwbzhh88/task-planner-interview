import type { GeneratedSchedule } from "./schedule";

// Structural boundary lets the same algorithm run against Prisma and test adapters.
export type QuotaTransaction = {
  user: { updateMany(args: {
    where: { id: string; credits: { gt: number } };
    data: { credits: { decrement: number } };
  }): Promise<{ count: number }> };
  planResult: { create(args: {
    data: { userId: string; content: string };
  }): Promise<unknown> };
};

export class GenerationError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode; }
}

/** Must run inside a transaction: provider/save errors must escape to roll back. */
export async function runGeneration(
  tx: QuotaTransaction,
  userId: string,
  generate: () => Promise<GeneratedSchedule>,
): Promise<GeneratedSchedule> {
  const claimed = await tx.user.updateMany({
    where: { id: userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
  if (claimed.count !== 1) throw new GenerationError(402, "额度不足，本次未调用生成接口。请刷新余额；当前暂无充值入口。");
  let schedule: GeneratedSchedule;
  try {
    schedule = await generate();
  } catch {
    throw new GenerationError(502, "模拟接口失败，本次不扣额度。请删除任务中的 [fail] 标记后重试。");
  }
  await tx.planResult.create({ data: { userId, content: JSON.stringify(schedule) } });
  return schedule;
}
