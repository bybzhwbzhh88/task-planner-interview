import { randomUUID } from "node:crypto";
import type { PlanResult, Task } from "wasp/entities";
import { HttpError, prisma } from "wasp/server";
import type {
  CreateTask,
  DeleteTask,
  GeneratePlan,
  GetAllTasksByUser,
  GetPlanResults,
  GetQuota,
  UpdateTask,
} from "wasp/server/operations";
import * as z from "zod";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import type { GeneratedSchedule } from "./schedule";
import { logQuotaFailure } from "./quotaDiagnostics";
import { generateMockSchedule } from "./mockAi";
import { generateWithQuota, getQuotaSnapshot, QuotaError } from "./quotaService";


//#region Actions
export const generatePlan: GeneratePlan<{ hours: number }, GeneratedSchedule> = async (args, context) => {
  try {
    return await generateWithQuota(prisma, context.user?.id, args, generateMockSchedule);
  } catch (error) {
    if (error instanceof QuotaError) {
      throw new HttpError(error.statusCode, error.message, { code: error.code, requestId: error.requestId });
    }
    const requestId = randomUUID();
    logQuotaFailure("action", error, { requestId, userId: context.user?.id });
    throw new HttpError(503, "服务暂不可用，请刷新额度与最近结果后再决定是否重试。", { code: "GENERATION_UNCERTAIN", requestId });
  }
};

export const getQuota: GetQuota<void, { availableCredits: number; processingCount: number }> = async (_args, context) => {
  if (!context.user) throw new HttpError(401, "请先登录。", { code: "AUTH_REQUIRED" });
  try {
    return await getQuotaSnapshot(prisma, context.user.id);
  } catch (error) {
    const requestId = randomUUID();
    logQuotaFailure("quota-query", error, { requestId, userId: context.user.id });
    throw new HttpError(503, "额度读取失败，请稍后刷新。", { code: "QUOTA_UNAVAILABLE", requestId });
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
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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

