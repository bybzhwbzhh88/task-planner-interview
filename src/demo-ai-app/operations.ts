import { Prisma } from "@prisma/client";
import type { PlanResult, Task } from "wasp/entities";
import { HttpError } from "wasp/server";
import type {
  CreateTask,
  DeleteTask,
  GeneratePlan,
  GetAllTasksByUser,
  GetPlanResults,
  GetCredits,
  UpdateTask,
} from "wasp/server/operations";
import * as z from "zod";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import type { GeneratedSchedule } from "./schedule";
import { generateMockSchedule } from "./mockAi";


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

  if (tasks.length === 0) {
    throw new HttpError(400, "请先添加待办事项。");
  }

  const userId = context.user.id;
  // One atomic database statement arbitrates concurrent callers, including
  // requests whose authentication context still contains an old balance.
  const reservation = await context.entities.User.updateMany({
    where: { id: userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
  if (reservation.count === 0) {
    throw new HttpError(402, "暂无可用额度，可能已用尽或正被其他生成请求占用。请刷新额度或查看历史日程。");
  }

  let phase: "model" | "save" = "model";
  try {
    const generatedSchedule = await generateMockSchedule(tasks, hours);
    phase = "save";
    await context.entities.PlanResult.create({
      data: { userId, content: JSON.stringify(generatedSchedule) },
    });
    return generatedSchedule;
  } catch (error) {
    // A connection failure can hide a successful INSERT. Do not refund an
    // ambiguous save automatically: the result and balance need inspection.
    const definiteSaveRejection = error instanceof Prisma.PrismaClientKnownRequestError
      && ["P2000", "P2002", "P2003", "P2011", "P2012", "P2014", "P2025"].includes(error.code);
    if (phase === "save" && !definiteSaveRejection) {
      console.error("quota.save_uncertain", { userId, error });
      throw new HttpError(503, "日程保存状态未能确认。请刷新并查看历史日程，联系维护者核查额度，暂勿重复提交。");
    }
    // Only the request that acquired a credit may return it, exactly once.
    try {
      await context.entities.User.update({
        where: { id: userId },
        data: { credits: { increment: 1 } },
      });
    } catch (refundError) {
      console.error("quota.refund_failed", { userId, phase, error, refundError });
      throw new HttpError(503, "生成失败，额度归还未能确认。请刷新额度并联系维护者核查，暂勿重复提交。");
    }
    console.error("plan.generation_failed", { userId, phase, error });
    throw new HttpError(
      phase === "model" ? 502 : 500,
      phase === "model"
        ? "模拟接口生成失败，额度已归还。请删除包含 [fail] 的任务后重试。"
        : "日程保存失败，额度已归还。请稍后重试。",
    );
  }
};

export const getCredits: GetCredits<void, number> = async (_args, context) => {
  if (!context.user) throw new HttpError(401);
  const user = await context.entities.User.findUniqueOrThrow({
    where: { id: context.user.id },
    select: { credits: true },
  });
  return user.credits;
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
    orderBy: { createdAt: "desc" },
    take: 10,
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
