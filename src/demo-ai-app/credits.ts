/**
 * 额度预扣 / 退还 / 提交（见 SPEC.md §2、§3）。
 *
 * 这里刻意不 import 任何 `wasp/*` 符号：额度逻辑只依赖调用方注入的最小存储接口，
 * 因此既能由 Wasp 运行时的实体客户端驱动，也能在测试里用假实现驱动（SPEC §8.1）。
 */

/**
 * 本模块需要的最小存储能力，形状与 Prisma model 方法一致。
 * 只声明用到的参数，避免把整个 Prisma 类型系统拖进额度逻辑。
 */
export type CreditStore = {
  user: {
    updateMany(args: {
      where: { id: string; credits: { gt: number } };
      data: { credits: { decrement: number } };
    }): Promise<{ count: number }>;
    update(args: {
      where: { id: string };
      data: { credits: { increment: number } };
    }): Promise<{ credits: number }>;
    findUnique(args: {
      where: { id: string };
      select: { credits: true };
    }): Promise<{ credits: number } | null>;
  };
  planResult: {
    create(args: {
      data: { userId: string; content: string };
    }): Promise<{ id: string }>;
  };
};

export type ReserveResult =
  | { ok: true }
  | { ok: false; reason: "insufficient_credits" };

/**
 * 原子预扣 1 额度，这是防止并发透支的唯一防线。
 *
 * `credits > 0` 写在 WHERE 子句里，判断与扣减压进同一条 SQL，由数据库行级锁保证
 * 同一行的更新串行执行：并发请求要么拿到 count=1，要么拿到 count=0，
 * 不存在"两个请求都读到 1"的窗口（SPEC §3.1）。
 *
 * 返回 `ok: false` 时调用方**不得**发起模型调用（SPEC §2.4）。
 * 用户行不存在也计为不足，避免把不存在当成可扣。
 */
export async function reserveCredit(
  store: CreditStore,
  userId: string,
): Promise<ReserveResult> {
  const { count } = await store.user.updateMany({
    where: { id: userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });

  return count === 1
    ? { ok: true }
    : { ok: false, reason: "insufficient_credits" };
}

/**
 * 退还 1 额度（SPEC §2.5）。
 *
 * 不抛异常：退还失败时由调用方记录 `credits.refund_failed` 并继续返回业务错误，
 * 避免把"退还失败"掩盖成"生成失败"。退还只会加回 1，不会让余额变负，因此不破坏不变式 I1。
 */
export async function refundCredit(
  store: CreditStore,
  userId: string,
): Promise<{ ok: boolean }> {
  try {
    await store.user.update({
      where: { id: userId },
      data: { credits: { increment: 1 } },
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * 预扣成功后落库，并读回当前余额（SPEC §2.3 第 6 步）。
 *
 * 余额在写库之后读取，因此并发场景返回的是"此刻"的余额，而不是本次扣减前的快照。
 * 本函数抛错时调用方必须退还额度（SPEC §3.4「commit 写库失败」）。
 */
export async function commitPlan(
  store: CreditStore,
  userId: string,
  content: string,
): Promise<{ planResultId: string; creditsRemaining: number }> {
  const planResult = await store.planResult.create({
    data: { userId, content },
  });

  const user = await store.user.findUnique({
    where: { id: userId },
    select: { credits: true },
  });

  return { planResultId: planResult.id, creditsRemaining: user?.credits ?? 0 };
}
