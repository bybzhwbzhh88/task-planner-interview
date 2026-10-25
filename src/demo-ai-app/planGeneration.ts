import { generationInput, type GenerationDeps, type GenerationOutcome, type GenerationStage, type StoredPlan } from "./generation";
import { classifyGenerationError } from "./generationDiagnostics";
import { generatedScheduleSchema } from "./schedule";

export class GenerationError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "NO_TASKS" | "NO_CREDITS") {
    super(code);
  }
}

/** Only the storage adapter may classify a write as definitively rejected. */
export class SaveRejectedError extends Error {}

export async function generateForUser(userId: string, args: unknown, deps: GenerationDeps): Promise<GenerationOutcome> {
  const input = generationInput.safeParse(args);
  if (!input.success) throw new GenerationError("INVALID_INPUT");
  const tasks = await deps.store.listTasks(userId);
  if (!tasks.length) throw new GenerationError("NO_TASKS");
  const requestId = deps.newId();
  // Diagnostics must never change the financial outcome of a request.
  const log = (event: string, stage?: GenerationStage, error?: unknown) => {
    try {
      const base = { event: `plan-generation.${event}`, requestId, userId };
      if (!stage) { deps.log(base); return; }
      // Only unwrap the adapter's own rejection wrapper; arbitrary causes stay private.
      const rejected = error instanceof SaveRejectedError;
      const details = classifyGenerationError(rejected ? error.cause : error);
      if (rejected && details.errorKind === "transport-or-unknown") details.errorKind = "save-rejected";
      deps.log({ ...base, stage, ...details });
    } catch { /* best effort: neither classification nor the sink can change settlement */ }
  };
  const unknown = (stage: GenerationStage, error: unknown): GenerationOutcome => {
    log("settlement-unknown", stage, error);
    return { status: "failed", code: "SETTLEMENT_UNKNOWN", requestId };
  };
  const refund = async (code: "MODEL_FAILED_REFUNDED" | "SAVE_FAILED_REFUNDED"): Promise<GenerationOutcome> => {
    try { await deps.store.refund(userId); } catch (error) { return unknown("refund", error); }
    log("refunded");
    return { status: "failed", code, requestId };
  };
  const success = async (plan: StoredPlan): Promise<GenerationOutcome> => {
    let availableCredits: number | null = null;
    try { availableCredits = await deps.store.credits(userId); } catch (error) { log("credits-unavailable", "credits", error); }
    log("succeeded");
    return { status: "succeeded", plan, availableCredits };
  };
  log("reserving");
  let reserved;
  try { reserved = await deps.store.reserve(userId); } catch (error) { return unknown("reserve", error); }
  if (!reserved) { log("no-credits"); throw new GenerationError("NO_CREDITS"); }
  log("reserved");
  let schedule;
  try {
    schedule = generatedScheduleSchema.parse(await deps.generate(tasks, input.data.hours, requestId));
  } catch (error) {
    log("model-error", "model", error);
    return refund("MODEL_FAILED_REFUNDED");
  }
  let plan;
  try {
    plan = await deps.store.save(userId, requestId, schedule);
  } catch (error) {
    log("save-error", "save", error);
    try {
      const saved = await deps.store.find(userId, requestId);
      if (saved) return success(saved);
    } catch (lookupError) { log("lookup-error", "lookup", lookupError); }
    if (error instanceof SaveRejectedError) return refund("SAVE_FAILED_REFUNDED");
    return unknown("save", error);
  }
  return success(plan);
}
