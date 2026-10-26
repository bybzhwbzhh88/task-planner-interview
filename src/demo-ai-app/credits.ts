import type { Prisma } from "@prisma/client";

/**
 * 额度存储的最小接口。
 *
 * 只声明了「占位」「退还」「读取余额」真正用到的两个方法，因此 Prisma 的
 * `prisma.user` 委托和 Wasp 注入的 `context.entities.User` 都满足它，
 * 验证脚本也能直接把 `new PrismaClient().user` 传进来跑同一份实现。
 *
 * 这里刻意不 import `wasp/server`，保证额度逻辑可以脱离 Wasp 运行时被验证。
 */
export interface CreditsStore {
  updateMany(args: Prisma.UserUpdateManyArgs): Promise<Prisma.BatchPayload>;
  findUnique(args: Prisma.UserFindUniqueArgs): Promise<unknown>;
}

export function logCreditsEvent(
  event: string,
  payload: Record<string, unknown>,
): void {
  console.info(JSON.stringify({ event, ...payload }));
}

/**
 * 原子占位：一条带条件的 UPDATE 就是唯一的额度闸门。
 *
 * `WHERE credits >= 1` 由数据库保证串行化——并发请求里只有 `credits` 个请求
 * 能拿到更新行数 1，其余请求拿到 0 并走额度不足分支，不会被扣成负数。
 *
 * @returns true 表示占位成功（已扣 1），false 表示额度不足（未扣减）。
 */
export async function reserveCredit(
  store: CreditsStore,
  userId: string,
  callId: string,
): Promise<boolean> {
  const { count } = await store.updateMany({
    where: { id: userId, credits: { gte: 1 } },
    data: { credits: { decrement: 1 } },
  });

  if (count === 0) {
    logCreditsEvent("credits.exhausted", { callId, userId, reserved: false });
    return false;
  }

  logCreditsEvent("credits.reserved", {
    callId,
    userId,
    reserved: true,
    rows: count,
  });
  return true;
}

/**
 * 退还：模型调用失败或未落库时把额度加回去。
 *
 * 调用方保证一次请求最多调用一次，不存在重复退还。
 */
export async function refundCredit(
  store: CreditsStore,
  userId: string,
  callId: string,
): Promise<void> {
  try {
    const { count } = await store.updateMany({
      where: { id: userId },
      data: { credits: { increment: 1 } },
    });
    logCreditsEvent("credits.refunded", { callId, userId, rows: count });
  } catch (error) {
    // 退还失败只能留给人工核对：宁可多点日志，也不要把真实错误吞掉。
    console.error(
      JSON.stringify({
        event: "credits.refund_failed",
        callId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
}

/** 读取当前余额，用于把最新额度返回给前端。 */
export async function readCredits(
  store: CreditsStore,
  userId: string,
): Promise<number> {
  const row = (await store.findUnique({
    where: { id: userId },
    select: { credits: true },
  })) as { credits: number } | null;

  return row?.credits ?? 0;
}
