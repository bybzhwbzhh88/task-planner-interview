import type { PlanResult, Task } from "wasp/entities";
import { HttpError, prisma } from "wasp/server";
import type {
  CreateTask,
  DeleteTask,
  GeneratePlan,
  GetAllTasksByUser,
  GetPlanResults,
  GetUserCredits,
  UpdateTask,
} from "wasp/server/operations";
import * as z from "zod";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import type { GeneratedSchedule } from "./schedule";
import { generatePlanWithQuota } from "./planGeneration";


//#region Actions
const generatePlanInputSchema = z.object({
  hours: z.number().min(0.5).max(24),
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

  // Quota handling lives in planGeneration.ts so it can be tested without
  // the Wasp runtime (see SPEC.md §5, step 1).
  const outcome = await generatePlanWithQuota(prisma, context.user.id, hours);

  switch (outcome.status) {
    case "success":
      return outcome.schedule;
    case "insufficient_credits":
      throw new HttpError(
        402,
        "额度不足：当前账号额度已用完，无法生成新日程。可查看历史日程；如需继续使用，请联系管理员重置额度。",
      );
    case "no_tasks":
      throw new HttpError(400, "请先添加待办事项，再生成日程。");
    case "provider_failed":
      throw new HttpError(
        500,
        "模型接口返回错误，本次未消耗额度。请检查任务列表后重试。",
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
/** Live credit balance from the database; never trust the request-time snapshot. */
export const getUserCredits: GetUserCredits<void, { credits: number }> = async (
  _args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(
      401,
      "Only authenticated users are allowed to perform this operation",
    );
  }
  const user = await context.entities.User.findUnique({
    where: { id: context.user.id },
  });
  if (!user) {
    throw new HttpError(404, "User not found");
  }
  return { credits: user.credits };
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
    orderBy: {
      createdAt: "desc",
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

