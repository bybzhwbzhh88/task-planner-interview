/**
 * 额度域：预占与退回。
 *
 * 这个文件刻意不 import Wasp / Prisma / React，只依赖下面声明的窄接口，
 * 因此额度规则可以被普通 Node 单测和真实 PostgreSQL 并发测试直接驱动。
 * Prisma 客户端在 `operations.ts` 里做一次性对齐。
 */

/** 账本 reason 取值，与 `SPEC.md` 第六节一致。 */
export const CREDIT_REASON = {
  /** 生成前预占 1 个额度 */
  reserved: "plan_reserved",
  /** 生成失败后退回预占的 1 个额度 */
  refunded: "plan_refunded",
} as const;

export type CreditReason = (typeof CREDIT_REASON)[keyof typeof CREDIT_REASON];

/** 额度不足。调用方必须在收到此错误时**不**发起模型调用。 */
export class QuotaExhaustedError extends Error {
  constructor(readonly userId: string) {
    super("No credit left for this user");
    this.name = "QuotaExhaustedError";
  }
}

/**
 * 生成失败。额度已尽力退回：
 * - `refundedBalance` 为退回后的余额；
 * - 为 `null` 表示退回本身失败，需要人工对账（见 SPEC 第九节）。
 */
export class PlanGenerationFailedError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly refundedBalance: number | null,
  ) {
    super("Plan generation failed", { cause: originalError });
    this.name = "PlanGenerationFailedError";
  }
}

/** 额度域用到的最小存储面，由 Prisma 客户端或测试替身实现。 */
export type QuotaStore = {
  user: {
    /** 条件更新：只有 `credits >= 1` 才命中，返回受影响行数以判断是否预占成功。 */
    updateMany(args: {
      where: { id: string; credits: { gte: number } };
      data: { credits: { decrement: number } };
    }): Promise<{ count: number }>;
    findUniqueOrThrow(args: {
      where: { id: string };
      select: { credits: true };
    }): Promise<{ credits: number }>;
    update(args: {
      where: { id: string };
      data: { credits: { increment: number } };
      select: { credits: true };
    }): Promise<{ credits: number }>;
  };
  creditLedgerEntry: {
    create(args: {
      data: {
        userId: string;
        delta: number;
        reason: CreditReason;
        balanceAfter: number;
      };
    }): Promise<unknown>;
  };
};

/** 事务执行器：把「预占 + 记账」放进同一个事务。 */
export type TxRunner = <T>(work: (store: QuotaStore) => Promise<T>) => Promise<T>;

/**
 * 原子预占 1 个额度，返回扣减后的余额。
 *
 * 判断与扣减是同一条 `UPDATE ... WHERE credits >= 1`，所以并发请求不会同时通过：
 * PostgreSQL 在 READ COMMITTED 下让同一行的 UPDATE 排队，后到者拿到锁后对新行版本
 * 重新判断条件，`credits` 已为 0 时匹配 0 行 → 抛出 `QuotaExhaustedError`。
 */
export async function reserveCredit(
  runTx: TxRunner,
  userId: string,
): Promise<number> {
  return runTx(async (store) => {
    const { count } = await store.user.updateMany({
      where: { id: userId, credits: { gte: 1 } },
      data: { credits: { decrement: 1 } },
    });
    if (count === 0) {
      throw new QuotaExhaustedError(userId);
    }

    // 同一事务内读取：该行已被本事务锁定，读到的是本次扣减后的确定值。
    const { credits } = await store.user.findUniqueOrThrow({
      where: { id: userId },
      select: { credits: true },
    });
    await store.creditLedgerEntry.create({
      data: {
        userId,
        delta: -1,
        reason: CREDIT_REASON.reserved,
        balanceAfter: credits,
      },
    });
    return credits;
  });
}

/** 退回 1 个额度（模型失败或落库失败时调用），返回退回后的余额。 */
export async function refundCredit(
  runTx: TxRunner,
  userId: string,
): Promise<number> {
  return runTx(async (store) => {
    const { credits } = await store.user.update({
      where: { id: userId },
      data: { credits: { increment: 1 } },
      select: { credits: true },
    });
    await store.creditLedgerEntry.create({
      data: {
        userId,
        delta: 1,
        reason: CREDIT_REASON.refunded,
        balanceAfter: credits,
      },
    });
    return credits;
  });
}
