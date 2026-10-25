import * as z from "zod";
import type { GeneratedSchedule } from "./schedule";

export const generationInput = z.object({ hours: z.number().min(1).max(24) });
export type GenerateInput = z.infer<typeof generationInput>;
export type PlanTask = { description: string; time: string };
export type StoredPlan = { id: string; createdAt: Date; schedule: GeneratedSchedule };
export function pickNewestPlan(local: StoredPlan | null, remote: StoredPlan | null | undefined): StoredPlan | null {
  if (!local) return remote ?? null;
  if (!remote) return local;
  const timeDifference = new Date(local.createdAt).getTime() - new Date(remote.createdAt).getTime();
  return timeDifference > 0 || (timeDifference === 0 && local.id > remote.id) ? local : remote;
}
export type FailureCode = "MODEL_FAILED_REFUNDED" | "SAVE_FAILED_REFUNDED" | "SETTLEMENT_UNKNOWN";
export type GenerationOutcome =
  | { status: "succeeded"; plan: StoredPlan; availableCredits: number | null }
  | { status: "failed"; code: FailureCode; requestId: string };
export type ViewerInput = { viewerId: string };
export type GenerationStage = "reserve" | "model" | "save" | "lookup" | "refund" | "credits";
export type GenerationErrorKind =
  | "prisma-known" | "prisma-initialization" | "prisma-validation" | "prisma-unknown" | "prisma-panic"
  | "result-validation" | "result-parse" | "save-rejected" | "transport-or-unknown";
export type SafeGenerationError = { errorKind: GenerationErrorKind; prismaCode?: string };
export type GenerationLogEvent = { event: string; requestId: string; userId: string } & Partial<SafeGenerationError & { stage: GenerationStage }>;
export interface PlanStore {
  listTasks(userId: string): Promise<PlanTask[]>;
  reserve(userId: string): Promise<boolean>;
  save(userId: string, requestId: string, schedule: GeneratedSchedule): Promise<StoredPlan>;
  find(userId: string, requestId: string): Promise<StoredPlan | null>;
  refund(userId: string): Promise<void>;
  credits(userId: string): Promise<number>;
}
export interface GenerationDeps {
  store: PlanStore;
  generate(tasks: PlanTask[], hours: number, requestId: string): Promise<unknown>;
  newId(): string;
  log(event: GenerationLogEvent): void;
}
