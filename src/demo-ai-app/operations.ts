import type { PlanResult, Task } from "wasp/entities";
import { HttpError } from "wasp/server";
import type {
  CreateTask,
  DeleteTask,
  GeneratePlan,
  GetAllTasksByUser,
  GetCurrentCredits,
  GetPlanResults,
  UpdateTask,
} from "wasp/server/operations";
import * as z from "zod";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import {
  CreditRefundError,
  CreditReservationError,
  executeWithReservedCredit,
  OutOfCreditsError,
  reserveCredit,
} from "./creditReservation";
import type { GeneratedSchedule } from "./schedule";
import { generateMockSchedule } from "./mockAi";


//#region Actions
const generatePlanInputSchema = z.object({
  hours: z.number().finite().min(1).max(24),
});

type GeneratePlanInput = z.infer<typeof generatePlanInputSchema>;

export const generatePlan: GeneratePlan<
  GeneratePlanInput,
  GeneratedSchedule
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
  const tasks = await context.entities.Task.findMany({
    where: {
      user: {
        id: context.user.id,
      },
    },
  });

  if (tasks.length === 0) {
    throw new HttpError(400, "Please add at least one task before generating");
  }

  const userId = context.user.id;

  try {
    return await executeWithReservedCredit({
      reserve: async () => {
        const reserved = await reserveCredit(userId, (args) =>
          context.entities.User.updateMany(args),
        );
        if (reserved) {
          console.info(JSON.stringify({ event: "credits.reserved", userId }));
        }
        return reserved;
      },
      generate: async () => generateMockSchedule(tasks, hours),
      persist: async (generatedSchedule) => {
        await context.entities.PlanResult.create({
          data: {
            user: { connect: { id: userId } },
            content: JSON.stringify(generatedSchedule),
          },
        });
      },
      refund: async () => {
        await context.entities.User.update({
          where: { id: userId },
          data: { credits: { increment: 1 } },
        });
        console.info(JSON.stringify({ event: "credits.refunded", userId }));
      },
    });
  } catch (error) {
    if (error instanceof OutOfCreditsError) {
      throw new HttpError(402, "User is out of credits");
    }
    if (error instanceof CreditReservationError) {
      console.error(
        JSON.stringify({ event: "credits.reservation-failed", userId }),
        error,
      );
      throw new HttpError(
        503,
        "Credit check failed. Generation was not started; please retry",
        { cause: error },
      );
    }
    if (error instanceof CreditRefundError) {
      console.error(
        JSON.stringify({ event: "credits.refund-failed", userId }),
        error,
      );
      throw new HttpError(
        500,
        "Generation failed and the credit refund could not be confirmed",
        { cause: error },
      );
    }

    console.error(
      JSON.stringify({ event: "plan-generation.failed", userId }),
      error,
    );
    throw new HttpError(
      502,
      "Generation failed. The reserved credit was refunded; please retry",
      { cause: error },
    );
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
export const getCurrentCredits: GetCurrentCredits<void, number> = async (
  _args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const user = await context.entities.User.findUnique({
    where: { id: context.user.id },
    select: { credits: true },
  });
  if (!user) {
    throw new HttpError(404, "User not found");
  }
  return user.credits;
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

