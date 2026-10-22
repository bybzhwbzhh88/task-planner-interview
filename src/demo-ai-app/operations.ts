import { randomUUID } from "node:crypto";
import type { PlanResult, Task } from "wasp/entities";
import { HttpError } from "wasp/server";
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
  commitPlan,
  refundCredit,
  reserveCredit,
  type CreditStore,
} from "./credits";
import { generateMockSchedule } from "./mockAi";
import type { GeneratedSchedule } from "./schedule";


//#region Actions
const generatePlanInputSchema = z.object({
  hours: z.number(),
});

type GeneratePlanInput = z.infer<typeof generatePlanInputSchema>;

export type GeneratePlanOutput = {
  schedule: GeneratedSchedule;
  creditsRemaining: number;
};

/**
 * 额度相关日志统一走这里，与 `mock-ai.*` 保持同样的 JSON 形状，
 * 一次尝试可以用同一个 callId 串起来（SPEC §4.4）。
 */
function logQuota(event: string, fields: Record<string, unknown>) {
  console.info(JSON.stringify({ event, ...fields }));
}

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
  const callId = randomUUID();
  const store: CreditStore = {
    user: {
      updateMany: (args) => context.entities.User.updateMany(args),
      update: (args) => context.entities.User.update(args),
      findUnique: (args) => context.entities.User.findUnique(args),
    },
    planResult: {
      create: (args) => context.entities.PlanResult.create(args),
    },
  };

  logQuota("credits.begin", { callId, userId });

  const tasks = await context.entities.Task.findMany({
    where: {
      user: {
        id: userId,
      },
    },
  });

  // 先预扣再调用：额度不足时一次模型调用都不发起，也不会写出产物（SPEC §2.4）。
  const reservation = await reserveCredit(store, userId);
  if (!reservation.ok) {
    logQuota("credits.reserve_failed", {
      callId,
      userId,
      reason: reservation.reason,
    });
    throw new HttpError(
      402,
      "Insufficient credits: the request was not sent to the provider",
    );
  }
  logQuota("credits.reserved", { callId, userId });

  let generatedSchedule: GeneratedSchedule;
  try {
    generatedSchedule = await generateMockSchedule(tasks, hours, callId);
  } catch {
    // 模型明确失败：退还预扣，并且不写产物（SPEC §2.5）。
    const refund = await refundCredit(store, userId);
    logQuota(refund.ok ? "credits.refunded" : "credits.refund_failed", {
      callId,
      userId,
      reason: "provider_failed",
    });
    throw new HttpError(502, "Provider failed: no credit was charged");
  }

  try {
    const { creditsRemaining } = await commitPlan(
      store,
      userId,
      JSON.stringify(generatedSchedule),
    );
    logQuota("credits.committed", { callId, userId, creditsRemaining });
    return { schedule: generatedSchedule, creditsRemaining };
  } catch {
    // 已预扣但产物没落库：退还，避免"扣了额度却没有产物"（SPEC §3.4）。
    const refund = await refundCredit(store, userId);
    logQuota(refund.ok ? "credits.refunded" : "credits.refund_failed", {
      callId,
      userId,
      reason: "persistence_failed",
    });
    throw new HttpError(
      500,
      "Failed to save the plan result: the credit was refunded",
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
export type CreditBalance = {
  credits: number;
};

/**
 * 当前用户的剩余额度。页面加载与生成失败后用它刷新余额（SPEC §4.2）。
 * 直接读库而不是 `context.user.credits`，避免拿到请求开始时的旧值（SPEC §1.3 A2）。
 */
export const getCreditBalance: GetCreditBalance<void, CreditBalance> = async (
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

