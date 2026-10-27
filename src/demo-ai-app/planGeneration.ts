import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import type { CreditsStore } from "./credits";
import { logCreditsEvent, readCredits, refundCredit, reserveCredit } from "./credits";
import type { GeneratedSchedule } from "./schedule";

/** 日程落库所需的最小接口，同样是 Prisma 委托的子集。 */
export interface PlanDb {
  user: CreditsStore;
  planResult: {
    create(args: Prisma.PlanResultCreateArgs): Promise<unknown>;
  };
}

export type PlanTaskInput = { description: string; time: string };

export type ScheduleProvider = (
  tasks: PlanTaskInput[],
  hours: number,
) => Promise<GeneratedSchedule>;

/** 额度不足：服务端未发起模型调用。 */
export class QuotaExhaustedError extends Error {
  constructor(message: string = "User is out of credits") {
    super(message);
    this.name = "QuotaExhaustedError";
  }
}

/** 模型调用失败：额度已退还，可以安全重试。 */
export class ProviderError extends Error {
  constructor(message: string = "Encountered a problem in communication with the mock provider") {
    super(message);
    this.name = "ProviderError";
  }
}

export interface GeneratePlanParams {
  db: PlanDb;
  userId: string;
  tasks: PlanTaskInput[];
  hours: number;
  /** 注入模型调用，便于验证脚本复用同一份流程并统计调用次数。 */
  provider: ScheduleProvider;
  callId?: string;
}

/**
 * action 的返回值。必须是 type alias 而不是 interface：Wasp 的 `Payload` 约束
 * 要求类型满足 `SuperJSONObject`（带 string index signature），而 TypeScript
 * 只会给 type alias 的对象类型隐式生成 index signature，interface 不会。
 */
export type GeneratePlanOutcome = {
  schedule: GeneratedSchedule;
  creditsRemaining: number;
};

/**
 * 日程生成的额度处理主流程：占位 → 调用 → 成功留存 / 失败退还。
 *
 * 这一段不 import 任何 Wasp 运行时，验证脚本可以脱离 Wasp 直接跑它。
 */
export async function generatePlanForUser(
  params: GeneratePlanParams,
): Promise<GeneratePlanOutcome> {
  const { db, userId, tasks, hours, provider } = params;
  const callId = params.callId ?? randomUUID();

  logCreditsEvent("plan.started", { callId, userId, tasks: tasks.length });

  // 1) 先占位。拿不到额度就直接失败，绝不发起模型调用。
  const reserved = await reserveCredit(db.user, userId, callId);
  if (!reserved) {
    throw new QuotaExhaustedError();
  }

  let schedule: GeneratedSchedule;
  try {
    // 2) 只有占位成功才调用模型。
    schedule = await provider(tasks, hours);
  } catch (error) {
    logCreditsEvent("plan.provider_failed", {
      callId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    await refundCredit(db.user, userId, callId);
    throw new ProviderError();
  }

  try {
    // 3) 成功才落库。
    await db.planResult.create({
      data: { userId, content: JSON.stringify(schedule) },
    });
  } catch (error) {
    logCreditsEvent("plan.persist_failed", {
      callId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    await refundCredit(db.user, userId, callId);
    throw error;
  }

  const creditsRemaining = await readCredits(db.user, userId);
  logCreditsEvent("plan.succeeded", { callId, userId, creditsRemaining });

  return { schedule, creditsRemaining };
}
