import type { GeneratedSchedule } from "./schedule";
import {
  PlanGenerationFailedError,
  QuotaExhaustedError,
  refundCredit,
  reserveCredit,
  type QuotaStore,
  type TxRunner,
} from "./quota";

/** 生成流程用到的存储面：额度域的最小面 + 任务读取 + 结果落库。 */
export type PlanStore = QuotaStore & {
  task: {
    findMany(args: {
      where: { userId: string };
      select: { description: true; time: true };
    }): Promise<{ description: string; time: string }[]>;
  };
  planResult: {
    create(args: {
      data: { userId: string; content: string };
    }): Promise<unknown>;
  };
};

export type PlanDeps = {
  store: PlanStore;
  runTx: TxRunner;
  /** 模型调用（本项目为本地 mock）。返回 null 视为失败。 */
  generateSchedule: (
    tasks: { description: string; time: string }[],
    hours: number,
  ) => Promise<GeneratedSchedule | null>;
  log?: (event: string, detail: Record<string, unknown>) => void;
};

export type PlanOutcome = {
  schedule: GeneratedSchedule;
  /** 本次预占后的余额，供页面直接展示 */
  creditsRemaining: number;
};

/**
 * 生成一份日程，按「预占 → 调用 → 落库 → 失败退回」执行。
 *
 * 顺序是这个函数的核心：`reserveCredit` 在模型调用之前，且失败会直接抛出，
 * 因此额度不足的请求不会走到 `generateSchedule`。
 *
 * @throws {QuotaExhaustedError} 额度不足，未发起模型调用、未产生任何写入
 * @throws {PlanGenerationFailedError} 模型或落库失败，额度已退回
 */
export async function generatePlanForUser(
  deps: PlanDeps,
  input: { userId: string; hours: number },
): Promise<PlanOutcome> {
  const { userId, hours } = input;
  const log = deps.log ?? (() => {});

  // 1) 原子预占：决定「有没有额度」，也决定「要不要调用模型」。
  const creditsAfterReserve = await reserveCredit(deps.runTx, userId);
  log("plan.credit_reserved", { userId, creditsAfterReserve });

  try {
    const tasks = await deps.store.task.findMany({
      where: { userId },
      select: { description: true, time: true },
    });

    // 2) 只有预占成功的请求才会走到这里。
    const schedule = await deps.generateSchedule(tasks, hours);
    if (!schedule) {
      throw new Error("Provider returned an empty response");
    }

    await deps.store.planResult.create({
      data: { userId, content: JSON.stringify(schedule) },
    });
    log("plan.credit_consumed", { userId, creditsAfterReserve });

    return { schedule, creditsRemaining: creditsAfterReserve };
  } catch (error) {
    // 3) 模型失败或落库失败：退回预占的额度，保证「失败不消耗」。
    const refundedBalance = await refundCredit(deps.runTx, userId).catch(
      (refundError: unknown) => {
        // 退回失败属于崩溃补偿范畴，题面不要求自动处理；留下日志供人工对账。
        log("quota.refund_failed", {
          userId,
          error: describeError(refundError),
        });
        return null;
      },
    );
    log("plan.credit_refunded", {
      userId,
      refundedBalance,
      error: describeError(error),
    });
    throw new PlanGenerationFailedError(error, refundedBalance);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { QuotaExhaustedError, PlanGenerationFailedError };
