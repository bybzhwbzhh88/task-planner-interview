import type { PlanResult, Task } from "wasp/entities";
import { HttpError } from "wasp/server";
import type {
  CreateTask,
  DeleteTask,
  GeneratePlan,
  GetAllTasksByUser,
  GetCredits,
  GetPlanResults,
  UpdateTask,
} from "wasp/server/operations";
import * as z from "zod";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import { generateMockSchedule } from "./mockAi";
import {
  generatePlanForUser,
  ProviderError,
  QuotaExhaustedError,
  type GeneratePlanOutcome,
} from "./planGeneration";

const OUT_OF_CREDITS_MESSAGE =
  "额度已用完：生成日程需要 1 个额度，当前账号没有剩余额度。";

const PROVIDER_FAILED_MESSAGE =
  "生成失败：模拟模型没有返回结果，本次不消耗额度，可调整任务后重试。";

//#region Actions
const generatePlanInputSchema = z.object({
  hours: z.number(),
});

type GeneratePlanInput = z.infer<typeof generatePlanInputSchema>;

export const generatePlan: GeneratePlan<
  GeneratePlanInput,
  GeneratePlanOutcome
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

  try {
    // 额度处理的主流程（占位 → 调用 → 成功留存 / 失败退还）在 planGeneration.ts，
    // 这一层只做登录校验、参数校验和错误码映射。
    return await generatePlanForUser({
      db: {
        user: context.entities.User,
        planResult: context.entities.PlanResult,
      },
      userId: context.user.id,
      tasks: tasks.map((task) => ({
        description: task.description,
        time: task.time,
      })),
      hours,
      provider: generateMockSchedule,
    });
  } catch (error) {
    if (error instanceof QuotaExhaustedError) {
      throw new HttpError(402, OUT_OF_CREDITS_MESSAGE);
    }
    if (error instanceof ProviderError) {
      throw new HttpError(502, PROVIDER_FAILED_MESSAGE);
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
export const getCredits: GetCredits<void, number> = async (
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

  return user?.credits ?? 0;
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
