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


//#region Actions
const generatePlanInputSchema = z.object({
  hours: z.number(),
});

type GeneratePlanInput = z.infer<typeof generatePlanInputSchema>;

export const generatePlan: GeneratePlan<
  GeneratePlanInput,
  GeneratedSchedule
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401, "请先登录");
  }

  const userId = context.user.id;

  const { hours } = ensureArgsSchemaOrThrowHttpError(
    generatePlanInputSchema,
    rawArgs,
  );

  const tasks = await context.entities.Task.findMany({
    where: { userId },
  });

  // 只有数据库中仍有额度时，才能预占一次生成资格。
  const reservation = await context.entities.User.updateMany({
    where: {
      id: userId,
      credits: { gt: 0 },
    },
    data: {
      credits: { decrement: 1 },
    },
  });

  if (reservation.count !== 1) {
    throw new HttpError(
      402,
      "暂无可用额度。如有生成中的请求，请等待其完成后刷新。",
    );
  }

  try {
    const generatedSchedule = await generateMockSchedule(tasks, hours);

    await context.entities.PlanResult.create({
      data: {
        user: { connect: { id: userId } },
        content: JSON.stringify(generatedSchedule),
      },
    });

    return generatedSchedule;
  } catch (error) {
    console.error("日程生成或保存失败", { userId, error });

    // 当前请求已预占额度，失败时只恢复一次。
    try {
      await context.entities.User.update({
        where: { id: userId },
        data: {
          credits: { increment: 1 },
        },
      });
    } catch (refundError) {
      console.error("额度恢复失败，需要人工检查", {
        userId,
        refundError,
      });

      throw new HttpError(
        500,
        "本次操作状态异常，额度恢复未确认，请联系维护者检查。",
      );
    }

    throw new HttpError(
      500,
      "本次生成未完成，额度已恢复，请稍后重试。",
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

export const getCredits: GetCredits<void, number> = async (
  _args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401, "请先登录");
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