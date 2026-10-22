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
import type { GeneratedSchedule } from "./schedule";
import { generateMockSchedule } from "./mockAi";
import {
  NoCreditError,
  RefundFailedError,
  ReservationStateUnknownError,
  runWithReservedCredit,
} from "./quota";


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
    throw new HttpError(400, "请先添加待办事项，再生成日程。");
  }

  const userId = context.user.id;
  const quotaStore = {
    reserveCredit: async (id: string) => {
      const result = await context.entities.User.updateMany({
        where: { id, credits: { gt: 0 } },
        data: { credits: { decrement: 1 } },
      });
      return result.count === 1;
    },
    refundCredit: async (id: string) => {
      await context.entities.User.update({
        where: { id },
        data: { credits: { increment: 1 } },
      });
    },
  };

  try {
    return await runWithReservedCredit(quotaStore, userId, async () => {
      const generatedSchedule = await generateMockSchedule(tasks, hours);
      if (generatedSchedule === null) {
        throw new Error("Mock provider returned no schedule");
      }
      await context.entities.PlanResult.create({
        data: {
          user: { connect: { id: userId } },
          content: JSON.stringify(generatedSchedule),
        },
      });
      return generatedSchedule;
    });
  } catch (error) {
    if (error instanceof NoCreditError) {
      throw new HttpError(402, "当前没有可用额度，请刷新后查看账号状态。");
    }
    if (
      error instanceof RefundFailedError ||
      error instanceof ReservationStateUnknownError
    ) {
      console.error("quota.state.unknown", { userId, error });
      throw new HttpError(500, "额度状态尚未确认，请刷新后核对，暂勿重复提交。");
    }
    console.error("plan.generate.failed", { userId, error });
    throw new HttpError(503, "日程生成失败，本次未扣额度。请修改任务或稍后重试。");
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
export const getCredits: GetCredits<void, number> = async (_args, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }
  const user = await context.entities.User.findUnique({
    where: { id: context.user.id },
    select: { credits: true },
  });
  if (!user) {
    throw new HttpError(404, "账号不存在");
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
    orderBy: { createdAt: "desc" },
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

