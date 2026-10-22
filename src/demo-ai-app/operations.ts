import type { PlanResult, Task } from "wasp/entities";
import { HttpError, prisma } from "wasp/server";
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
import type { GeneratedSchedule } from "./schedule";
import { generateMockSchedule } from "./mockAi";


//#region Actions
const generatePlanInputSchema = z.object({
  hours: z.number(),
});

type GeneratePlanInput = z.infer<typeof generatePlanInputSchema>;

export type GeneratePlanResult = {
  schedule: GeneratedSchedule;
  creditsRemaining: number;
};

/**
 * 退回一次预留。退补失败不重试，避免把已失败的请求变成无限重试。
 * 返回是否真的退成功：调用方据此决定能不能对用户说"未扣除额度"。
 */
async function refundCredit(userId: string): Promise<boolean> {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { credits: { increment: 1 } },
    });
    console.log(JSON.stringify({ event: "quota.refunded", userId }));
    return true;
  } catch (err) {
    console.error(JSON.stringify({ event: "quota.refund_failed", userId }), err);
    return false;
  }
}

export const generatePlan: GeneratePlan<
  GeneratePlanInput,
  GeneratePlanResult
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
  const tasks = await context.entities.Task.findMany({
    where: {
      user: {
        id: userId,
      },
    },
  });

  // 预留：条件判断与扣减写在同一条 UPDATE 里，并发请求由数据库在该行上串行化。
  // 只有预留成功的请求才允许调用模型，额度不足的请求在这里直接失败。
  const reserved = await context.entities.User.updateMany({
    where: { id: userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
  if (reserved.count === 0) {
    console.log(JSON.stringify({ event: "quota.rejected", userId }));
    throw new HttpError(402, "额度不足：本次未调用模型，也未扣除额度");
  }

  let generatedSchedule: GeneratedSchedule;
  try {
    console.log("Calling mock AI provider");
    generatedSchedule = await generateMockSchedule(tasks, hours);
  } catch (err) {
    console.error(JSON.stringify({ event: "generate_plan.provider_failed" }), err);
    const refunded = await refundCredit(userId);
    if (!refunded) {
      // 退补本身失败：额度可能已被扣且没退回来，此时不能说"未扣除额度"。
      throw new HttpError(
        500,
        "生成失败，且额度状态待确认：请刷新页面查看剩余额度后再决定是否重试",
      );
    }
    throw new HttpError(502, "生成失败：本次未扣除额度，可直接重试");
  }

  try {
    await context.entities.PlanResult.create({
      data: {
        user: { connect: { id: userId } },
        content: JSON.stringify(generatedSchedule),
      },
    });
  } catch (err) {
    console.error(JSON.stringify({ event: "generate_plan.save_failed" }), err);
    const refunded = await refundCredit(userId);
    if (!refunded) {
      throw new HttpError(
        500,
        "保存日程失败，且额度状态待确认：请刷新页面查看剩余额度后再决定是否重试",
      );
    }
    throw new HttpError(500, "保存日程失败：本次未扣除额度，可直接重试");
  }

  const user = await context.entities.User.findUniqueOrThrow({
    where: { id: userId },
    select: { credits: true },
  });

  return { schedule: generatedSchedule, creditsRemaining: user.credits };
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

export const getMyCredits: GetMyCredits<void, number> = async (
  _args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }
  const user = await context.entities.User.findUnique({
    where: {
      id: context.user.id,
    },
    select: {
      credits: true,
    },
  });
  return user?.credits ?? 0;
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

