import type { PrismaClient } from "@prisma/client";
import { generateMockSchedule } from "./mockAi";
import type { GeneratedSchedule } from "./schedule";

/**
 * Database surface required by the generation flow. The Wasp operation passes
 * the shared Prisma singleton; tests pass their own client connected to an
 * isolated test database.
 */
export type GenerationDb = Pick<PrismaClient, "user" | "task" | "planResult">;

export type GeneratePlanOutcome =
  | { status: "success"; schedule: GeneratedSchedule }
  | { status: "insufficient_credits" }
  | { status: "no_tasks" }
  | { status: "provider_failed"; message: string };

/**
 * Plan generation with credit quota, following the reserve-and-refund flow
 * from SPEC.md §3/§4:
 *
 * 1. Reject an empty task list before touching credits or the provider.
 * 2. Atomically reserve one credit (single conditional UPDATE, so concurrent
 *    requests for the same account cannot overdraw).
 * 3. Call the mock provider and persist the result.
 * 4. On any failure after the reservation, refund the credit.
 */
export async function generatePlanWithQuota(
  db: GenerationDb,
  userId: string,
  hours: number,
): Promise<GeneratePlanOutcome> {
  const tasks = await db.task.findMany({ where: { userId } });
  if (tasks.length === 0) {
    return { status: "no_tasks" };
  }

  if (!(await reserveCredit(db, userId))) {
    return { status: "insufficient_credits" };
  }

  try {
    const schedule = await generateMockSchedule(tasks, hours);
    await db.planResult.create({
      data: { userId, content: JSON.stringify(schedule) },
    });
    return { status: "success", schedule };
  } catch (err) {
    await refundCredit(db, userId);
    return {
      status: "provider_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Reserve one credit as a single conditional UPDATE: the row-level lock makes
 * concurrent reservations serialize, and the `credits > 0` guard is evaluated
 * against the current value, not a stale snapshot. This is the step that
 * prevents overdraft (SPEC.md §4).
 */
async function reserveCredit(
  db: GenerationDb,
  userId: string,
): Promise<boolean> {
  const { count } = await db.user.updateMany({
    where: { id: userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
  if (count > 0) {
    console.info(JSON.stringify({ event: "credits.reserved", userId }));
  }
  return count > 0;
}

/**
 * Refund a reserved credit when the provider call or the persistence of its
 * result fails. Refund failure is an accepted limitation (SPEC.md §2): we log
 * it and keep propagating the original error instead of swallowing it.
 */
async function refundCredit(db: GenerationDb, userId: string): Promise<void> {
  try {
    await db.user.updateMany({
      where: { id: userId },
      data: { credits: { increment: 1 } },
    });
    console.info(JSON.stringify({ event: "credits.refunded", userId }));
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "credits.refund-failed",
        userId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
