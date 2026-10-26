import { prisma } from "wasp/server";

/**
 * 只声明用到的那两个方法。生产环境传入 Prisma client，
 * 测试传假存储，调用方代码完全一致。
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
  };
};

/**
 * 条件扣减：只有余额大于 0 时才扣得动。
 *
 * 返回是否扣到——调用方据此决定要不要发起模型调用。
 * 判断和扣减在同一条 UPDATE 里完成，由数据库串行化，
 * 因此并发请求不会读到同一个余额快照而重复通过检查。
 */
export async function tryConsumeCredit(
  userId: string,
  client: CreditsClient = prisma,
): Promise<boolean> {
  const result = await client.user.updateMany({
    where: { id: userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
  return result.count === 1;
}

/** 退还一次额度，用于模型调用或落库失败时的补偿。 */
export async function refundCredit(
  userId: string,
  client: CreditsClient = prisma,
): Promise<void> {
  await client.user.update({
    where: { id: userId },
    data: { credits: { increment: 1 } },
  });
}
