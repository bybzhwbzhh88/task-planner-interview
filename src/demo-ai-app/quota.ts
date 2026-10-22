import type { Prisma, PrismaClient } from "@prisma/client";
import * as z from "zod";

import type { GeneratedSchedule } from "./schedule";

export type TaskInput = {
  description: string;
  time: string;
};

export type QuotaDeps = {
  db: PrismaClient;
  generate: (tasks: TaskInput[], hours: number) => Promise<GeneratedSchedule>;
  persist?: (
    tx: Prisma.TransactionClient,
    data: { userId: string; content: string },
  ) => Promise<unknown>;
};

export type QuotaErrorStatus = 400 | 401 | 402 | 502;

export class QuotaError extends Error {
  readonly status: QuotaErrorStatus;

  constructor(
    status: QuotaErrorStatus,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "QuotaError";
    this.status = status;
  }
}

export const hoursSchema = z
  .number()
  .min(1)
  .max(24)
  .refine((value) => Number.isFinite(value), {
    message: "工作时长必须是有限数字",
  });

export type GeneratePlanWithQuotaInput = {
  userId: string | null;
  hours: unknown;
};

// Keep the credit claim and result write in one transaction; errors roll both back.
export async function generatePlanWithQuota(
  input: GeneratePlanWithQuotaInput,
  deps: QuotaDeps,
): Promise<GeneratedSchedule> {
  const { userId } = input;

  if (!userId) {
    throw new QuotaError(401, "请先登录");
  }

  const parsedHours = hoursSchema.safeParse(input.hours);
  if (!parsedHours.success) {
    throw new QuotaError(400, "工作时长需为 1–24 之间的有限数字");
  }
  const hours = parsedHours.data;

  const tasks = await deps.db.task.findMany({
    where: { userId },
    select: { description: true, time: true },
  });

  if (tasks.length === 0) {
    throw new QuotaError(400, "请先添加至少一个任务");
  }

  const persist: NonNullable<QuotaDeps["persist"]> =
    deps.persist ??
    (async (tx, data) => {
      await tx.planResult.create({
        data: {
          content: data.content,
          user: { connect: { id: data.userId } },
        },
      });
    });

  return deps.db.$transaction(
    async (tx) => {
      const claimed = await tx.user.updateMany({
        where: { id: userId, credits: { gt: 0 } },
        data: { credits: { decrement: 1 } },
      });

      if (claimed.count === 0) {
        throw new QuotaError(402, "额度不足，无法生成");
      }

      let schedule: GeneratedSchedule;
      try {
        schedule = await deps.generate(tasks, hours);
      } catch (error) {
        throw new QuotaError(502, "模拟生成失败，本次未扣费", {
          cause: error,
        });
      }

      await persist(tx, {
        userId,
        content: JSON.stringify(schedule),
      });

      return schedule;
    },
    {
      isolationLevel: "ReadCommitted",
      maxWait: 10_000,
      timeout: 15_000,
    },
  );
}

export async function readCredits(
  db: PrismaClient,
  userId: string,
): Promise<number | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { credits: true },
  });

  return user?.credits ?? null;
}
