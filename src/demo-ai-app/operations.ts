import type { PlanResult, Task } from "wasp/entities";
import { HttpError, prisma } from "wasp/server";
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
import type { GeneratedSchedule } from "./schedule";
import { generateMockSchedule } from "./mockAi";


//#region Actions
const generatePlanInputSchema = z.object({
  hours: z.number(),
});

type GeneratePlanInput = z.infer<typeof generatePlanInputSchema>;

/** `context.entities.User` 的最小接口，只取额度处理真正用到的两个方法。 */
type UserDelegate = Pick<
  typeof prisma.user,
  "updateMany" | "findUnique"
>;

/**
 * 原子预占一个额度。
 *
 * 防透支的关键就在这里：检查与扣减是同一条 SQL
 * `UPDATE "User" SET credits = credits - 1 WHERE id = ? AND credits >= 1`，
 * PostgreSQL 对命中行加排他锁，使并发请求在此串行化。余额不足时
 * `credits >= 1` 不成立，`count` 返回 0，调用方据此拒绝且不会触达模型。
 *
 * 用 `updateMany` 而非 `update`：后者在 where 不匹配时抛 RecordNotFound，
 * 无法区分「余额不足」与「用户不存在」。
 */
async function reserveCredit(
  users: UserDelegate,
  userId: string,
): Promise<boolean> {
  const { count } = await users.updateMany({
    where: { id: userId, credits: { gte: 1 } },
    data: { credits: { decrement: 1 } },
  });
  return count === 1;
}

/**
 * 回补一个额度。仅在确实预占成功、但后续步骤失败时调用一次。
 * 用 `credits: { gte: 0 }` 兜住用户已被删除的情况，避免抛错掩盖原始异常。
 */
async function releaseCredit(
  users: UserDelegate,
  userId: string,
): Promise<void> {
  try {
    await users.updateMany({
      where: { id: userId, credits: { gte: 0 } },
      data: { credits: { increment: 1 } },
    });
  } catch (error) {
    // 回补失败意味着这一点额度丢失（见 SPEC.md 限制 L2）。
    // 记录后不再抛出，以免覆盖真正导致失败的原始错误。
    console.error(
      JSON.stringify({ event: "credit.release-failed", userId }),
      error,
    );
  }
}

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

  // 步骤①：调用模型之前先原子预占额度。
  // 额度不足时在这里终止，`generateMockSchedule` 不会被调用，
  // 服务端日志因此不会出现 `mock-ai.started`。
  const users = context.entities.User as unknown as UserDelegate;
  const reserved = await reserveCredit(users, context.user.id);
  if (!reserved) {
    console.info(
      JSON.stringify({
        event: "credit.insufficient",
        userId: context.user.id,
      }),
    );
    throw new HttpError(
      402,
      "额度已用完，本次未调用模型也未扣除额度。请等待额度恢复后再试。",
    );
  }

  // 步骤②：调用模型。失败则回补额度，不扣费。
  let generatedSchedule: GeneratedSchedule;
  try {
    console.log("Calling mock AI provider");
    generatedSchedule = await generateMockSchedule(tasks, hours);
  } catch (error) {
    await releaseCredit(users, context.user.id);
    console.info(
      JSON.stringify({
        event: "credit.released",
        userId: context.user.id,
        reason: "provider-failed",
      }),
    );
    throw new HttpError(
      502,
      "模型返回失败，本次未扣除额度，可以直接重试。",
      { cause: error },
    );
  }

  // 步骤③：保存结果。保存失败同样回补，避免「扣了额度却没有日程」。
  try {
    console.log("Decrementing credits and saving response");
    await context.entities.PlanResult.create({
      data: {
        user: { connect: { id: context.user.id } },
        content: JSON.stringify(generatedSchedule),
      },
    });
  } catch (error) {
    await releaseCredit(users, context.user.id);
    console.info(
      JSON.stringify({
        event: "credit.released",
        userId: context.user.id,
        reason: "persist-failed",
      }),
    );
    throw new HttpError(
      500,
      "日程已生成但保存失败，本次未扣除额度，请重试。",
      { cause: error },
    );
  }

  return generatedSchedule;
};

/** 供前端展示与刷新的剩余额度。额度以数据库为准，不读请求快照。 */
export const getCreditBalance: GetCreditBalance<void, { credits: number }> =
  async (_args, context) => {
    if (!context.user) {
      throw new HttpError(401);
    }

    const user = await context.entities.User.findUnique({
      where: { id: context.user.id },
      select: { credits: true },
    });

    // 理论上不会发生：登录态存在但用户行已被删除。返回 0 而非抛错，
    // 避免前端额度组件因异常而整页失败。
    return { credits: user?.credits ?? 0 };
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

