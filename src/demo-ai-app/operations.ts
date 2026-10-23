import type { PlanResult, Task } from "wasp/entities";
import { HttpError, prisma } from "wasp/server";
import type {
  CreateTask,
  DeleteTask,
  GeneratePlan,
  GetAllTasksByUser,
  GetCreditStatus,
  GetPlanResults,
  UpdateTask,
} from "wasp/server/operations";
import * as z from "zod";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import { generateMockSchedule } from "./mockAi";
import {
  generatePlanForUser,
  PlanGenerationFailedError,
  QuotaExhaustedError,
  type PlanOutcome,
  type PlanStore,
} from "./planFlow";
import type { QuotaStore, TxRunner } from "./quota";

// Prisma 客户端 → 流程层窄接口的唯一接线点。Prisma 类型由 Wasp 生成，
// 这里做一次结构对齐，领域代码（quota.ts / planFlow.ts）就不必依赖 Wasp。
const planStore = prisma as unknown as PlanStore;
const runTx: TxRunner = (work) =>
  prisma.$transaction((tx) => work(tx as unknown as QuotaStore));

const logEvent = (event: string, detail: Record<string, unknown>) => {
  console.info(JSON.stringify({ event, ...detail }));
};

//#region Actions
const generatePlanInputSchema = z.object({
  hours: z.number(),
});

type GeneratePlanInput = z.infer<typeof generatePlanInputSchema>;

export const generatePlan: GeneratePlan<GeneratePlanInput, PlanOutcome> = async (
  rawArgs,
  context,
) => {
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

  try {
    return await generatePlanForUser(
      {
        store: planStore,
        runTx,
        generateSchedule: (tasks, hours) => {
          logEvent("plan.provider_calling", { userId: context.user!.id });
          return generateMockSchedule(tasks, hours);
        },
        log: logEvent,
      },
      { userId: context.user.id, hours },
    );
  } catch (error) {
    if (error instanceof QuotaExhaustedError) {
      // 402：额度不足。此时尚未调用模型，也没有任何写入。
      throw new HttpError(402, "额度不足，本次未发起生成");
    }
    if (error instanceof PlanGenerationFailedError) {
      // 502：上游（模型）失败或落库失败，已退回预占的额度。
      throw new HttpError(502, "生成失败，本次占用的额度已退回");
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
export type CreditStatus = { credits: number };

export const getCreditStatus: GetCreditStatus<void, CreditStatus> = async (
  _args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }
  // 从数据库读，而不是用 context.user.credits（登录态快照，可能已过期）。
  const { credits } = await prisma.user.findUniqueOrThrow({
    where: { id: context.user.id },
    select: { credits: true },
  });
  return { credits };
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

