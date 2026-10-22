import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import * as z from "zod";
import { generateMockSchedule } from "./mockAi";
import { generatedScheduleSchema, type GeneratedSchedule } from "./schedule";
import { PlanError } from "./planError";
import { createQuotaService, TransactionFailure, type QuotaService } from "./quotaService";

const inputSchema = z.object({ hours: z.number().finite().min(1).max(24) });

interface PlanDependencies {
  db: PrismaClient;
  quota?: QuotaService;
  model?: typeof generateMockSchedule;
}

export async function generatePlanForUser(
  rawArgs: unknown,
  user: { id: string; credits?: number } | undefined,
  dependencies: PlanDependencies,
): Promise<GeneratedSchedule> {
  if (!user) throw new PlanError(401, "AUTH_REQUIRED", "请登录后生成日程。");
  const input = inputSchema.safeParse(rawArgs);
  if (!input.success) throw new PlanError(400, "INVALID_INPUT", "可用时长须为 1～24 小时的有限数值。");
  const { db, model = generateMockSchedule, quota = createQuotaService(db) } = dependencies;

  let tasks;
  try {
    tasks = await db.task.findMany({ where: { userId: user.id } });
  } catch {
    throw new PlanError(503, "DB_UNAVAILABLE", "服务暂不可用，本次未消费额度，请稍后重试。");
  }
  if (!tasks.length) throw new PlanError(400, "INVALID_INPUT", "请先添加待办事项。");
  const attemptId = randomUUID();

  async function settleFailure(code: "PROVIDER_FAILED" | "SAVE_FAILED" | "DB_UNAVAILABLE"): Promise<GeneratedSchedule> {
    for (let retry = 0; retry < 2; retry++) {
      try {
        const settlement = await quota.release(user!.id, attemptId);
        if (settlement.status === "SUCCEEDED") return settlement.schedule;
        if (settlement.status === "RELEASED") {
          const messages = {
            PROVIDER_FAILED: "生成失败，额度已释放；请调整任务后重试。",
            SAVE_FAILED: "日程保存失败，额度已释放；请稍后重试。",
            DB_UNAVAILABLE: "服务暂不可用，本次未消费额度，请稍后重试。",
          };
          throw new PlanError(
            code === "PROVIDER_FAILED" ? 502 : code === "SAVE_FAILED" ? 500 : 503,
            code, messages[code], attemptId,
          );
        }
      } catch (error) {
        if (error instanceof PlanError) throw error;
        console.error(JSON.stringify({ event: "quota.settlement-unconfirmed", attemptId, stage: code, retry }));
      }
    }
    throw new PlanError(503, "OUTCOME_UNKNOWN", "结果暂无法确认，请刷新核对并保留请求编号反馈。", attemptId);
  }

  try {
    await quota.reserve(user.id, attemptId);
  } catch (error) {
    if (error instanceof PlanError) throw error;
    if (error instanceof TransactionFailure && error.rollbackConfirmed) {
      throw new PlanError(503, "DB_UNAVAILABLE", "服务暂不可用，本次未消费额度，请稍后重试。", attemptId);
    }
    return settleFailure("DB_UNAVAILABLE");
  }

  let generated: GeneratedSchedule;
  try {
    generated = await model(tasks, input.data.hours);
  } catch {
    return settleFailure("PROVIDER_FAILED");
  }

  try {
    const content = JSON.stringify(generatedScheduleSchema.parse(generated));
    const settlement = await quota.confirm(user.id, attemptId, content);
    if (settlement.status === "SUCCEEDED") return settlement.schedule;
  } catch {
    // A rejected commit reply may follow a successful commit: arbitrate by
    // this attempt's state instead of refunding based on the exception alone.
  }
  return settleFailure("SAVE_FAILED");
}
