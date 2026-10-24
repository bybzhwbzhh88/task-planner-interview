import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type Task } from "@prisma/client";
import * as z from "zod";
import type { GeneratedSchedule } from "./schedule";
import { logQuotaFailure } from "./quotaDiagnostics";

export class QuotaError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public requestId?: string) {
    super(message);
  }
}

export type Provider = (tasks: { description: string; time: string }[], hours: number, requestId: string) => Promise<GeneratedSchedule>;
export type Faults = {
  beforeSave?: () => void | Promise<void>;
  afterSaveCommit?: () => void | Promise<void>;
  beforeRefund?: () => void | Promise<void>;
  beforeRecoveryRead?: () => void | Promise<void>;
  afterReserveCommit?: () => void | Promise<void>;
};
const input = z.object({ hours: z.number().finite().min(1).max(24).multipleOf(0.5) });
const messages: Record<string, string> = {
  PROVIDER_FAILED: "本地模拟生成失败，本次未消耗额度。请移除任务中的 [fail] 后重试。",
  RESULT_SAVE_FAILED: "日程保存失败，额度已归还，请稍后重试。",
};
function event(name: string, requestId: string, userId: string, code?: string) {
  console.info(JSON.stringify({ event: `generation.${name}`, requestId, userId, code }));
}

export async function getQuotaSnapshot(db: PrismaClient, userId: string) {
  return db.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { credits: true } });
    const processingCount = await tx.generationRequest.count({ where: { userId, status: "PROCESSING" } });
    return { availableCredits: user.credits, processingCount };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function refundRequest(db: PrismaClient, userId: string, requestId: string, code: string, faults: Faults = {}) {
  await faults.beforeRefund?.();
  const changed = await db.$transaction(async (tx) => {
    const state = await tx.generationRequest.updateMany({
      where: { id: requestId, userId, status: "PROCESSING" },
      data: { status: "FAILED", failureCode: code },
    });
    if (state.count === 1) await tx.user.update({ where: { id: userId }, data: { credits: { increment: 1 } } });
    return state.count;
  });
  if (changed === 1) event("refunded", requestId, userId, code);
}

export async function saveSuccess(db: PrismaClient, userId: string, requestId: string, schedule: GeneratedSchedule, faults: Faults = {}) {
  const result = await db.$transaction(async (tx) => {
    const updated = await tx.generationRequest.updateMany({ where: { id: requestId, userId, status: "PROCESSING" }, data: { status: "SUCCEEDED" } });
    if (updated.count === 0) {
      const previous = await tx.planResult.findFirst({ where: { generationRequestId: requestId, userId } });
      if (!previous) throw new Error("Request is no longer processing");
      return JSON.parse(previous.content) as GeneratedSchedule;
    }
    await faults.beforeSave?.();
    await tx.planResult.create({ data: { userId, generationRequestId: requestId, content: JSON.stringify(schedule) } });
    return schedule;
  });
  await faults.afterSaveCommit?.();
  event("succeeded", requestId, userId);
  return result;
}

async function recover(db: PrismaClient, userId: string, requestId: string, code: string, faults: Faults, allowMissing = false): Promise<GeneratedSchedule> {
  try {
    await faults.beforeRecoveryRead?.();
    const state = await db.generationRequest.findFirst({ where: { id: requestId, userId }, include: { result: true } });
    if (state?.status === "SUCCEEDED" && state.result) return JSON.parse(state.result.content) as GeneratedSchedule;
    if (state?.status === "PROCESSING") await refundRequest(db, userId, requestId, code, faults);
    else if (!state && !allowMissing) throw new Error("Missing reservation");
    // Re-read after refund: an ambiguous commit must never be advertised as refunded.
    const confirmed = await db.generationRequest.findFirst({ where: { id: requestId, userId }, include: { result: true } });
    if (confirmed?.status === "SUCCEEDED" && confirmed.result) return JSON.parse(confirmed.result.content) as GeneratedSchedule;
    if (confirmed?.status !== "FAILED" && !(allowMissing && !confirmed)) throw new Error("Unconfirmed refund");
  } catch (error) {
    logQuotaFailure("recovery", error, { requestId, userId, code });
    event("uncertain", requestId, userId, code);
    throw new QuotaError(503, "GENERATION_UNCERTAIN", "生成结果暂未确认，请先刷新额度与最近结果，再决定是否重试。", requestId);
  }
  throw new QuotaError(code === "PROVIDER_FAILED" ? 502 : 500, code, messages[code] ?? "请求未完成，本次未消耗额度，请刷新后重试。", requestId);
}

export async function generateWithQuota(db: PrismaClient, userId: string | undefined, raw: unknown, provider: Provider, faults: Faults = {}) {
  if (!userId) throw new QuotaError(401, "AUTH_REQUIRED", "请先登录。");
  const parsed = input.safeParse(raw);
  if (!parsed.success) throw new QuotaError(400, "INVALID_INPUT", "时长须为 1～24 小时，步长为 0.5 小时。");
  const requestId = randomUUID();
  let tasks: Task[];
  try {
    tasks = await db.task.findMany({ where: { userId } });
  } catch (error) {
    logQuotaFailure("preflight", error, { requestId, userId });
    throw new QuotaError(503, "GENERATION_UNCERTAIN", "服务暂不可用，请刷新额度与最近结果后再决定是否重试。", requestId);
  }
  if (!tasks.length) throw new QuotaError(400, "NO_TASKS", "请先添加待办事项。");
  try {
    await db.$transaction(async (tx) => {
      const reserved = await tx.user.updateMany({ where: { id: userId, credits: { gt: 0 } }, data: { credits: { decrement: 1 } } });
      if (reserved.count !== 1) throw new QuotaError(402, "QUOTA_EXHAUSTED", "可用额度不足，请刷新额度；如有处理中请求，请等待完成。");
      await tx.generationRequest.create({ data: { id: requestId, userId } });
    });
    await faults.afterReserveCommit?.();
  } catch (error) {
    if (error instanceof QuotaError) throw error;
    logQuotaFailure("reservation", error, { requestId, userId, code: "RESERVATION_FAILED" });
    return recover(db, userId, requestId, "RESERVATION_FAILED", faults, true);
  }
  event("reserved", requestId, userId);
  let schedule: GeneratedSchedule;
  try {
    schedule = await provider(tasks, parsed.data.hours, requestId);
  } catch (error) {
    logQuotaFailure("provider", error, { requestId, userId, code: "PROVIDER_FAILED" });
    return recover(db, userId, requestId, "PROVIDER_FAILED", faults);
  }
  try {
    return await saveSuccess(db, userId, requestId, schedule, faults);
  } catch (error) {
    logQuotaFailure("save", error, { requestId, userId, code: "RESULT_SAVE_FAILED" });
    return recover(db, userId, requestId, "RESULT_SAVE_FAILED", faults);
  }
}
