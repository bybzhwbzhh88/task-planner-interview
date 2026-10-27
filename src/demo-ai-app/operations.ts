import type { PlanResult, Task } from "wasp/entities";
import { HttpError, prisma } from "wasp/server";
import type {
  CreateTask,
  DeleteTask,
  GeneratePlan,
  GetAllTasksByUser,
  GetCreditBalance,
  GetPlanResults,
  UpdateTask,
} from "wasp/server/operations";
import * as z from "zod";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import {
  CreditRefundError,
  generatePlanWithQuota,
  InsufficientCreditsError,
  ModelRejectedError,
  type GeneratePlanResult,
  type PlanRepository,
} from "./generate-plan";
import { generateMockSchedule } from "./mockAi";


//#region Actions
const generatePlanInputSchema = z.object({
  hours: z.number(),
});

type GeneratePlanInput = z.infer<typeof generatePlanInputSchema>;

export const generatePlan: GeneratePlan<
  GeneratePlanInput,
  GeneratePlanResult
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

  const repo: PlanRepository = {
    async listTasks(ownerId) {
      return context.entities.Task.findMany({
        where: { user: { id: ownerId } },
        select: { description: true, time: true },
      });
    },
    async reserveCredit(ownerId) {
      // Single guarded UPDATE: PostgreSQL re-checks `credits > 0` after any
      // row-lock wait, so concurrent requests cannot both take the last credit.
      // The balance read is in the same transaction: if it fails, the decrement
      // rolls back and the request cannot lose a credit silently.
      const [updateResult, user] = await prisma.$transaction([
        prisma.user.updateMany({
          where: { id: ownerId, credits: { gt: 0 } },
          data: { credits: { decrement: 1 } },
        }),
        prisma.user.findUnique({
          where: { id: ownerId },
          select: { credits: true },
        }),
      ]);
      return {
        ok: updateResult.count === 1,
        remainingCredits: user?.credits ?? 0,
      };
    },
    async refundCredit(ownerId) {
      await context.entities.User.update({
        where: { id: ownerId },
        data: { credits: { increment: 1 } },
      });
    },
    async savePlanResult(ownerId, content) {
      await context.entities.PlanResult.create({
        data: {
          user: { connect: { id: ownerId } },
          content,
        },
      });
    },
  };

  try {
    return await generatePlanWithQuota(
      { userId, hours },
      { repo, generateSchedule: generateMockSchedule },
    );
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      throw new HttpError(402, "INSUFFICIENT_CREDITS", {
        remainingCredits: error.remainingCredits,
      });
    }
    if (error instanceof ModelRejectedError) {
      throw new HttpError(502, "MODEL_REJECTED");
    }
    if (error instanceof CreditRefundError) {
      console.error("Failed to refund a reserved credit", error);
      throw new HttpError(500, "CREDIT_REFUND_FAILED");
    }
    throw error;
  }
};

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
export const getCreditBalance: GetCreditBalance<
  void,
  { credits: number }
> = async (_args, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }
  const user = await context.entities.User.findUnique({
    where: { id: context.user.id },
    select: { credits: true },
  });
  return { credits: user?.credits ?? 0 };
};

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

