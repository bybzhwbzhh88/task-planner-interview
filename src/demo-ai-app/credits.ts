import { prisma } from "wasp/server";

/**
 * 条件扣减：只有余额大于 0 时才扣得动。
 *
 * 返回是否扣到——调用方据此决定要不要发起模型调用。
 * 判断和扣减在同一条 UPDATE 里完成，由数据库串行化，
 * 因此并发请求不会读到同一个余额快照而重复通过检查。
 */
export async function tryConsumeCredit(userId: string): Promise<boolean> {
  const result = await prisma.user.updateMany({
    where: { id: userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
  return result.count === 1;
}

/** 退还一次额度，用于模型调用或落库失败时的补偿。 */
export async function refundCredit(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { credits: { increment: 1 } },
  });
}
