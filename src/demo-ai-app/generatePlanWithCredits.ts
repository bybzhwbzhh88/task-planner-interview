import { Prisma, type PrismaClient } from "@prisma/client";
import type { generateMockSchedule } from "./mockAi";
import type { GeneratedSchedule } from "./schedule";

export class PlanGenerationError extends Error {
  constructor(
    readonly reason: "no-credits" | "no-tasks" | "provider-failed",
    options?: ErrorOptions,
  ) {
    super(reason, options);
    this.name = "PlanGenerationError";
  }
}

/** Only for the bounded local provider. See SPEC.md before adding a remote one. */
export async function generatePlanWithCredits(
  db: Pick<PrismaClient, "$transaction">,
  userId: string,
  hours: number,
  generateSchedule: typeof generateMockSchedule,
): Promise<GeneratedSchedule> {
  return db.$transaction(
    async (tx) => {
      // The database, not an auth snapshot, arbitrates the last credit.
      // Concurrent updates of this user's row wait and re-check this predicate.
      const reserved = await tx.user.updateMany({
        where: { id: userId, credits: { gt: 0 } },
        data: { credits: { decrement: 1 } },
      });
      if (reserved.count !== 1) throw new PlanGenerationError("no-credits");

      const tasks = await tx.task.findMany({ where: { userId } });
      if (tasks.length === 0) throw new PlanGenerationError("no-tasks");

      let schedule: GeneratedSchedule;
      try {
        schedule = await generateSchedule(tasks, hours);
        if (schedule == null) throw new Error("Provider returned no schedule");
      } catch (cause) {
        throw new PlanGenerationError("provider-failed", { cause });
      }

      await tx.planResult.create({
        data: { userId, content: JSON.stringify(schedule) },
      });
      return schedule;
    },
    {
      // ReadCommitted re-evaluates credits > 0 after a competing update commits.
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 15_000,
    },
  );
}
