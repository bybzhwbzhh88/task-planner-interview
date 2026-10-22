import { Prisma, type PrismaClient } from "@prisma/client";
import type { QuotaStore } from "./quota";

/** A single conditional UPDATE is the admission boundary, before any model call. */
export function createQuotaStore(db: Pick<PrismaClient, "user" | "planResult">): QuotaStore {
  return {
    async reserve(userId) {
      const updated = await db.user.updateMany({
        where: { id: userId, credits: { gt: 0 } },
        data: { credits: { decrement: 1 } },
      });
      return updated.count === 1;
    },
    async release(userId) {
      await db.user.update({
        where: { id: userId },
        data: { credits: { increment: 1 } },
      });
    },
    async saveResult(id, userId, content) {
      await db.planResult.create({ data: { id, userId, content } });
    },
    isDefiniteSaveFailure(error) {
      // Local validation and explicit statement rejections cannot have inserted
      // a row. All transport/time-out/unknown failures remain conservative.
      return error instanceof Prisma.PrismaClientValidationError || (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2000", "P2002", "P2003", "P2011", "P2025"].includes(error.code)
      );
    },
  };
}
