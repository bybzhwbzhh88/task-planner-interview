import { randomUUID } from "node:crypto";
import type { PlanResult, Task } from "wasp/entities";
import { HttpError } from "wasp/server";
import type {
  CreateTask,
  DeleteTask,
  GeneratePlan,
  GetAllTasksByUser,
  GetPlanResults,
  GetCredits,
  GetLatestPlan,
  UpdateTask,
} from "wasp/server/operations";
import * as z from "zod";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import type { GenerateInput, GenerationOutcome, StoredPlan, ViewerInput } from "./generation";
import { generateForUser, GenerationError } from "./planGeneration";
import { createPlanStore, parsePlan } from "./planStore";
import { generateMockSchedule } from "./mockAi";


//#region Actions
export const generatePlan: GeneratePlan<GenerateInput, GenerationOutcome> = async (rawArgs, context) => {
  if (!context.user) throw new HttpError(401, "请重新登录。", { code: "NOT_AUTHENTICATED" });
  try {
    return await generateForUser(context.user.id, rawArgs, {
      store: createPlanStore({ user: context.entities.User, task: context.entities.Task, planResult: context.entities.PlanResult }),
      generate: generateMockSchedule,
      newId: randomUUID,
      log: event => console.info(JSON.stringify(event)),
    });
  } catch (error) {
    if (error instanceof GenerationError) {
      const messages = { INVALID_INPUT: "请输入 1–24 小时的有效时长。", NO_TASKS: "请先添加任务。", NO_CREDITS: "当前没有可用额度，本次未调用模型。" };
      throw new HttpError(error.code === "NO_CREDITS" ? 402 : 400, messages[error.code], { code: error.code });
    }
    // All uncertain writes are already converted to typed outcomes by the orchestration.
    console.error(JSON.stringify({ event: "plan-generation.before-reservation-error", userId: context.user.id }));
    throw new HttpError(500, "本次请求未执行，请刷新后重试。");
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



function requireViewer(rawArgs: unknown, userId: string | undefined): string {
  if (!userId) throw new HttpError(401, "请重新登录。");
  const parsed = z.object({ viewerId: z.string().nonempty() }).safeParse(rawArgs);
  if (!parsed.success) throw new HttpError(400, "账号查询参数无效。");
  if (parsed.data.viewerId !== userId) throw new HttpError(403, "账号已变化，请刷新页面。");
  return userId;
}

export const getCredits: GetCredits<ViewerInput, { availableCredits: number }> = async (args, context) => {
  const userId = requireViewer(args, context.user?.id);
  const user = await context.entities.User.findUnique({ where: { id: userId }, select: { credits: true } });
  if (!user) throw new HttpError(401, "请重新登录。");
  return { availableCredits: user.credits };
};

export const getLatestPlan: GetLatestPlan<ViewerInput, StoredPlan | null> = async (args, context) => {
  const userId = requireViewer(args, context.user?.id);
  const record = await context.entities.PlanResult.findFirst({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return record ? parsePlan(record) : null;
};
