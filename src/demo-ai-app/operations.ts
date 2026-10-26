import type { PlanResult, Task } from "wasp/entities";
import { HttpError } from "wasp/server";
import type {
  CreateTask,
  DeleteTask,
  GeneratePlan,
  GetAllTasksByUser,
  GetMyCredits,
  GetPlanResults,
  UpdateTask,
} from "wasp/server/operations";
import * as z from "zod";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import { refundCredit, tryConsumeCredit } from "./credits";
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

  // 先占位：扣到额度才允许调用模型。余额不足时模型一次都不会被调到，
  // 并发请求也会在这里被数据库的串行化挡下一个。
  const consumed = await tryConsumeCredit(context.user.id);
  if (!consumed) {
    throw new HttpError(
      402,
      "额度已用完，本次未生成日程，也没有消耗额度。",
    );
  }

  try {
    console.log("Calling mock AI provider");
    const generatedSchedule = await generateMockSchedule(tasks, hours);

    await context.entities.PlanResult.create({
      data: {
        user: { connect: { id: context.user.id } },
        content: JSON.stringify(generatedSchedule),
      },
    });

    return generatedSchedule;
  } catch (error) {
    // 模型失败、超时、返回结构不合法，或落库失败：用户没拿到日程，就不该计费。
    try {
      await refundCredit(context.user.id);
      console.error("generatePlan failed, credit refunded", error);
    } catch (refundError) {
      // 退还本身失败意味着额度被吞了，必须留痕，便于人工补偿。
      console.error("generatePlan failed AND refund failed", error, refundError);
    }
    throw new HttpError(424, "生成失败，本次未消耗额度。请稍后重试。");
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

/** 当前用户剩余额度，供页面展示。读库而不是读会话快照，避免显示过期余额。 */
export const getMyCredits: GetMyCredits<void, number> = async (
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
//#endregion

