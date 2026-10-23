import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reserveCredit } from "./creditReservation";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("credit reservation with PostgreSQL", () => {
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("atomically grants one of five concurrent reservations", async () => {
    if (!prisma) throw new Error("Prisma client was not initialized");

    const user = await prisma.user.create({ data: { credits: 1 } });
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          reserveCredit(user.id, (args) => prisma!.user.updateMany(args)),
        ),
      );
      const storedUser = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(storedUser.credits).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
