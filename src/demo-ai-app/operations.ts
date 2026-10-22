import type { PlanResult, Task } from "wasp/entities";
import { HttpError, prisma } from "wasp/server";
import type {
  CreateTask,
  DeleteTask,
  GeneratePlan,
  GetAllTasksByUser,
  GetPlanResults,
  UpdateTask,
} from "wasp/server/operations";
import * as z from "zod";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import type { GeneratedSchedule } from "./schedule";
import { generateMockSchedule } from "./mockAi";
import {
  generateScheduleWithQuota,
  QuotaGenerationError,
} from "./quotaGeneration";


//#region Actions
const generatePlanInputSchema = z.object({
  hours: z.number().min(1).max(24),
});

type GeneratePlanInput = z.infer<typeof generatePlanInputSchema>;

export type GeneratePlanOutput = {
  schedule: GeneratedSchedule;
  creditsRemaining: number;
};

export const generatePlan: GeneratePlan<
  GeneratePlanInput,
  GeneratePlanOutput
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(
      401,
      "Only authenticated users are allowed to perform this operation",
    );
  }

  const { hours } = ensureArgsSchemaOrThrowHttpError(
    generatePlanInputSchema,
    rawArgs,
  );
  const userId = context.user.id;
  const tasks = await context.entities.Task.findMany({
    where: {
      user: {
        id: userId,
      },
    },
  });

  if (tasks.length === 0) {
    throw new HttpError(400, "请先添加至少一条待办任务");
  }

  try {
    return await generateScheduleWithQuota({
      userId,
      tasks,
      hours,
      generateSchedule: generateMockSchedule,
      store: {
        reserveCredit: async (id) => {
          const reservation = await context.entities.User.updateMany({
            where: {
              id,
              credits: { gt: 0 },
            },
            data: {
              credits: { decrement: 1 },
            },
          });
          return reservation.count === 1;
        },
        refundCredit: async (id) => {
          const user = await context.entities.User.update({
            where: { id },
            data: { credits: { increment: 1 } },
            select: { credits: true },
          });
          return user.credits;
        },
        saveResultAndGetBalance: async (id, schedule) => {
          return prisma.$transaction(async (tx) => {
            await tx.planResult.create({
              data: {
                userId: id,
                content: JSON.stringify(schedule),
              },
            });
            const user = await tx.user.findUniqueOrThrow({
              where: { id },
              select: { credits: true },
            });
            return user.credits;
          });
        },
      },
    });
  } catch (error) {
    if (error instanceof QuotaGenerationError) {
      throw quotaErrorToHttpError(error);
    }
    throw error;
  }
};

function quotaErrorToHttpError(error: QuotaGenerationError): HttpError {
  const data = { code: error.kind };
  switch (error.kind) {
    case "insufficient-credits":
      return new HttpError(
        402,
        "额度不足：本次未调用模型，也未扣除额度。",
        data,
        { cause: error },
      );
    case "provider-failed":
      return new HttpError(
        502,
        "模拟模型生成失败，本次额度已退回。",
        data,
        { cause: error },
      );
    case "persistence-failed":
      return new HttpError(
        500,
        "保存日程失败，本次额度已退回。",
        data,
        { cause: error },
      );
    case "refund-failed":
      return new HttpError(
        500,
        "额度归还失败，请刷新后确认余额并联系维护者。",
        data,
        { cause: error },
      );
  }
}

const createTaskInputSchema = z.object({
  description: z.string().nonempty(),
});

type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const createTask: CreateTask<CreateTaskInput, Task> = async (
  rawArgs,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const { description } = ensureArgsSchemaOrThrowHttpError(
    createTaskInputSchema,
    rawArgs,
  );

  const task = await context.entities.Task.create({
    data: {
      description,
      user: { connect: { id: context.user.id } },
    },
  });

  return task;
};

const updateTaskInputSchema = z.object({
  id: z.string().nonempty(),
  isDone: z.boolean().optional(),
  time: z.string().optional(),
});

type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

export const updateTask: UpdateTask<UpdateTaskInput, Task> = async (
  rawArgs,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const { id, isDone, time } = ensureArgsSchemaOrThrowHttpError(
    updateTaskInputSchema,
    rawArgs,
  );

  const task = await context.entities.Task.update({
    where: {
      id,
      user: {
        id: context.user.id,
      },
    },
    data: {
      isDone,
      time,
    },
  });

  return task;
};

const deleteTaskInputSchema = z.object({
  id: z.string().nonempty(),
});

type DeleteTaskInput = z.infer<typeof deleteTaskInputSchema>;

export const deleteTask: DeleteTask<DeleteTaskInput, Task> = async (
  rawArgs,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const { id } = ensureArgsSchemaOrThrowHttpError(
    deleteTaskInputSchema,
    rawArgs,
  );

  const task = await context.entities.Task.delete({
    where: {
      id,
      user: {
        id: context.user.id,
      },
    },
  });

  return task;
};
//#endregion

//#region Queries
export const getPlanResults: GetPlanResults<void, PlanResult[]> = async (
  _args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }
  return context.entities.PlanResult.findMany({
    where: {
      user: {
        id: context.user.id,
      },
    },
  });
};

export const getAllTasksByUser: GetAllTasksByUser<void, Task[]> = async (
  _args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }
  return context.entities.Task.findMany({
    where: {
      user: {
        id: context.user.id,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });
};
//#endregion

