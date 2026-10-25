import { Prisma, type PrismaClient } from "@prisma/client";
import type { PlanStore, StoredPlan } from "./generation";
import { SaveRejectedError } from "./planGeneration";
import { generatedScheduleSchema } from "./schedule";

export type PlanClient = Pick<PrismaClient, "user" | "task" | "planResult">;
export function parsePlan(record: { id: string; createdAt: Date; content: string }): StoredPlan {
  return { id: record.id, createdAt: record.createdAt, schedule: generatedScheduleSchema.parse(JSON.parse(record.content)) };
}

export function createPlanStore(client: PlanClient): PlanStore {
  return {
    listTasks: userId => client.task.findMany({ where: { userId }, select: { description: true, time: true } }),
    async reserve(userId) {
      const result = await client.user.updateMany({ where: { id: userId, credits: { gt: 0 } }, data: { credits: { decrement: 1 } } });
      return result.count === 1;
    },
    async save(userId, requestId, schedule) {
      let record;
      try {
        record = await client.planResult.create({ data: { id: requestId, userId, content: JSON.stringify(schedule) } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientValidationError ||
          (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2003"].includes(error.code))) {
          throw new SaveRejectedError("Database rejected plan write", { cause: error });
        }
        throw error;
      }
      return parsePlan(record);
    },
    async find(userId, requestId) {
      const record = await client.planResult.findFirst({ where: { id: requestId, userId } });
      return record ? parsePlan(record) : null;
    },
    async refund(userId) {
      const result = await client.user.updateMany({ where: { id: userId }, data: { credits: { increment: 1 } } });
      if (result.count !== 1) throw new Error("Refund was not confirmed");
    },
    async credits(userId) {
      const user = await client.user.findUniqueOrThrow({ where: { id: userId }, select: { credits: true } });
      return user.credits;
    },
  };
}
