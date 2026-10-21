/**
 * 额度的三种原子操作：预扣、退回、查询。
 *
 * 并发安全的关键在 reserveCredit：它是一条带条件的 UPDATE
 * （UPDATE "User" SET credits = credits - 1 WHERE id = $1 AND credits > 0），
 * 数据库对同一行的并发写天然串行，affected count 为 0 即表示额度不足
 * 或已被并发请求扣走。调用方不需要额外加锁或事务。
 *
 * 函数只依赖结构化的 Prisma delegate 类型，不耦合 Wasp，
 * 便于在运行时之外复用与测试（见 scripts/verify-credits.mjs）。
 */

export type CreditsClient = {
  user: {
    updateMany(args: {
      where: { id: string; credits: { gt: number } };
      data: { credits: { decrement: number } };
    }): Promise<{ count: number }>;
    update(args: {
      where: { id: string };
      data: { credits: { increment: number } };
    }): Promise<unknown>;
    findUnique(args: {
      where: { id: string };
      select: { credits: true };
    }): Promise<{ credits: number } | null>;
  };
};

/** 原子预扣 1 个额度。返回 false 表示额度不足（不应发起模型调用）。 */
export async function reserveCredit(
  client: CreditsClient,
  userId: string,
): Promise<boolean> {
  const result = await client.user.updateMany({
    where: { id: userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
  return result.count > 0;
}

/** 退回 1 个额度（模型明确失败时调用，无条件执行，总是成功）。 */
export async function refundCredit(
  client: CreditsClient,
  userId: string,
): Promise<void> {
  await client.user.update({
    where: { id: userId },
    data: { credits: { increment: 1 } },
  });
}

/** 查询当前剩余额度。 */
export async function getCredits(
  client: CreditsClient,
  userId: string,
): Promise<number> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { credits: true },
  });
  return user?.credits ?? 0;
}
