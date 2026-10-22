import { randomUUID } from "node:crypto";
import { generatedScheduleSchema, type GeneratedSchedule } from "./schedule";

export interface QuotaStore {
  reserve(userId: string): Promise<boolean>;
  release(userId: string): Promise<void>;
  saveResult(id: string, userId: string, content: string): Promise<void>;
  isDefiniteSaveFailure(error: unknown): boolean;
}

export class QuotaError extends Error {
  constructor(
    readonly statusCode: 402 | 500 | 502,
    readonly code: "NO_CREDITS" | "MODEL_FAILED" | "SAVE_FAILED" | "RESULT_UNCERTAIN",
    message: string,
    readonly requestId: string,
  ) {
    super(message);
    this.name = "QuotaError";
  }
}

export type QuotaEvent = {
  event: string;
  requestId: string;
  userId: string;
  resultId: string;
};

const uncertainMessage = "暂时无法确认本次结果或额度，请刷新查看，避免重复提交。";

/** The same orchestration is used by the Wasp action and database tests. */
export async function generateWithQuota({
  userId,
  store,
  generate,
  log = (entry) => console.info(JSON.stringify(entry)),
}: {
  userId: string;
  store: QuotaStore;
  generate: () => Promise<unknown>;
  log?: (entry: QuotaEvent) => void;
}): Promise<GeneratedSchedule> {
  // Preassign the result ID so an uncertain INSERT can be investigated later.
  const requestId = randomUUID();
  const emit = (event: string) => log({ event, requestId, userId, resultId: requestId });
  const uncertain = () => new QuotaError(500, "RESULT_UNCERTAIN", uncertainMessage, requestId);

  let reserved: boolean;
  try {
    reserved = await store.reserve(userId);
  } catch {
    // The UPDATE may have committed; do not guess whether a refund is safe.
    emit("quota.reservation-uncertain");
    throw uncertain();
  }
  if (!reserved) {
    emit("quota.rejected");
    throw new QuotaError(402, "NO_CREDITS", "当前没有可用额度。若有其他生成进行中，请稍后刷新额度。", requestId);
  }
  emit("quota.reserved");

  // Called from one failure branch only; never retry an uncertain increment.
  const release = async () => {
    try {
      await store.release(userId);
    } catch {
      emit("quota.release-uncertain");
      throw uncertain();
    }
    emit("quota.released");
  };

  let schedule: GeneratedSchedule;
  try {
    // This project only uses a local provider with definite success/failure.
    schedule = generatedScheduleSchema.parse(await generate());
  } catch {
    emit("quota.model-failed");
    await release();
    throw new QuotaError(502, "MODEL_FAILED", "本次生成失败，未消耗额度。请检查任务后重试。", requestId);
  }

  try {
    await store.saveResult(requestId, userId, JSON.stringify(schedule));
  } catch (error) {
    if (!store.isDefiniteSaveFailure(error)) {
      // A connection error does not prove that the INSERT was rolled back.
      emit("quota.save-uncertain");
      throw uncertain();
    }
    emit("quota.save-failed");
    await release();
    throw new QuotaError(500, "SAVE_FAILED", "结果保存失败，未消耗额度。请稍后重试。", requestId);
  }
  emit("quota.saved");
  return schedule;
}
