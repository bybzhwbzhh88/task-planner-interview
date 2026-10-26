import type { PlanResult, Task } from "wasp/entities";
import { HttpError, prisma } from "wasp/server";
import type {
  CreateTask,
  DeleteTask,
  GeneratePlan,
  GetCredits,
  GetAllTasksByUser,
  GetPlanResults,
  UpdateTask,
} from "wasp/server/operations";
import * as z from "zod";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import type { GeneratedSchedule } from "./schedule";
import { generateMockSchedule } from "./mockAi";
import { runGeneration, GenerationError } from "./quota";


//#region Actions
const generatePlanInputSchema = z.object({
  hours: z.number().min(1).max(24),
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

  if (tasks.length === 0) throw new HttpError(400, "请先添加待办事项。");
  try {
    return await prisma.$transaction(
      (tx) => runGeneration(tx, context.user!.id, () => generateMockSchedule(tasks, hours)),
      { maxWait: 10_000, timeout: 15_000 },
    );
  } catch (error) {
    if (error instanceof GenerationError) throw new HttpError(error.statusCode, error.message);
    console.error("plan.generation.failed", error);
    throw new HttpError(503, "生成未确认成功，请刷新余额和历史日程后再决定是否重试。");
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


export const getCredits: GetCredits<void, number> = async (_args, context) => {
  if (!context.user) throw new HttpError(401);
  const user = await context.entities.User.findUniqueOrThrow({ where: { id: context.user.id } });
  return user.credits;
};
