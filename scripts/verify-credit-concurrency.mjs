import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const userId = randomUUID();

try {
  await prisma.user.create({ data: { id: userId, credits: 3 } });

  const reservations = await Promise.all(
    Array.from({ length: 5 }, () =>
      prisma.user.updateMany({
        where: { id: userId, credits: { gt: 0 } },
        data: { credits: { decrement: 1 } },
      }),
    ),
  );
  const accepted = reservations.filter(({ count }) => count === 1).length;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  assert.equal(accepted, 3, "only the three available credits can be reserved");
  assert.equal(user.credits, 0, "credits must not become negative");
  console.log(`PASS: ${accepted}/5 reservations accepted; final credits=${user.credits}`);
} finally {
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
