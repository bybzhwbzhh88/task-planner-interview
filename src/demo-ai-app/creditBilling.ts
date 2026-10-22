import type { PrismaClient } from "@prisma/client";
import type { GeneratedSchedule } from "./schedule";

export class InsufficientCreditsError extends Error {
  constructor() {
    super("User is out of credits");
    this.name = "InsufficientCreditsError";
  }
}

export class ScheduleGenerationError extends Error {
  constructor(cause: unknown) {
    super("The mock provider failed to generate a schedule", { cause });
    this.name = "ScheduleGenerationError";
  }
}

export class SchedulePersistenceError extends Error {
  constructor(cause: unknown) {
    super("The generated schedule could not be saved", { cause });
    this.name = "SchedulePersistenceError";
  }
}

export class CreditRefundError extends Error {
  constructor(cause: unknown) {
    super("The reserved credit could not be refunded", { cause });
    this.name = "CreditRefundError";
  }
}

type GeneratePlanWithCreditArgs = {
  prisma: PrismaClient;
  userId: string;
  generateSchedule: () => Promise<GeneratedSchedule>;
};

export type CreditBilledSchedule = {
  schedule: GeneratedSchedule;
  remainingCredits: number;
};

async function refundReservedCredit(prisma: PrismaClient, userId: string) {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { credits: { increment: 1 } },
    });
  } catch (error) {
    throw new CreditRefundError(error);
  }
}

export async function generatePlanWithCredit({
  prisma,
  userId,
  generateSchedule,
}: GeneratePlanWithCreditArgs): Promise<CreditBilledSchedule> {
  const reservedRows = await prisma.$queryRaw<Array<{ credits: number }>>`
    UPDATE "User"
    SET "credits" = "credits" - 1
    WHERE "id" = ${userId} AND "credits" > 0
    RETURNING "credits"
  `;

  const reservation = reservedRows[0];
  if (!reservation) {
    throw new InsufficientCreditsError();
  }

  let schedule: GeneratedSchedule;
  try {
    schedule = await generateSchedule();
  } catch (error) {
    await refundReservedCredit(prisma, userId);
    throw new ScheduleGenerationError(error);
  }

  try {
    await prisma.planResult.create({
      data: {
        userId,
        content: JSON.stringify(schedule),
      },
    });
  } catch (error) {
    await refundReservedCredit(prisma, userId);
    throw new SchedulePersistenceError(error);
  }

  return {
    schedule,
    remainingCredits: reservation.credits,
  };
}
