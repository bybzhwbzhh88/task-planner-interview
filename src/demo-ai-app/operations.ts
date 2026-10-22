import type { PlanResult, Task } from "wasp/entities";
import { HttpError, prisma } from "wasp/server";
import type {
  CreateTask,
  DeleteTask,
  GeneratePlan,
  GetAllTasksByUser,
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
    throw new HttpError(
      401,
      "Only authenticated users are allowed to perform this operation",
    );
  }

  const { hours } = ensureArgsSchemaOrThrowHttpError(
    generatePlanInputSchema,
    rawArgs,
  );

  // Tasks are fetched before reserving a credit so that an empty task list
  // never touches the balance at all.
  const tasks = await context.entities.Task.findMany({
    where: {
      user: {
        id: context.user.id,
      },
    },
  });
  if (tasks.length === 0) {
    throw new HttpError(400, "Add at least one task before generating a plan");
  }

  // Reserve one credit BEFORE calling the provider. The conditional
  // single-statement update (UPDATE ... SET credits = credits - 1 WHERE
  // credits > 0) is what prevents overdraft under concurrency: PostgreSQL
  // holds a row lock for the update, so only one request can claim the last
  // credit and every other request observes count === 0 here.
  const reservation = await context.entities.User.updateMany({
    where: { id: context.user.id, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
  if (reservation.count === 0) {
    // No model call is made when the user is out of credits.
    throw new HttpError(402, "User is out of credits");
  }

  console.log("Calling mock AI provider");
  let generatedSchedule: GeneratedSchedule;
  try {
    generatedSchedule = await generateMockSchedule(tasks, hours);
  } catch (err) {
    // The provider explicitly rejected the call: refund the reserved credit
    // so a failed generation never consumes quota.
    await refundCredit(context.user.id);
    throw new HttpError(
      502,
      "The mock provider rejected the request. No credits were consumed; remove any task containing [fail] and try again.",
    );
  }

  try {
    await context.entities.PlanResult.create({
      data: {
        user: { connect: { id: context.user.id } },
        content: JSON.stringify(generatedSchedule),
      },
    });
  } catch (err) {
    // The provider call succeeded, so the credit stays consumed (this is a
    // platform-side failure; automatic compensation is out of scope).
    console.error(
      "Failed to persist PlanResult after a successful generation",
      err,
    );
    throw new HttpError(500, "Failed to save the generated plan");
  }

  console.log("Saved generated schedule, credit consumed");
  return generatedSchedule;
};

/** Atomically returns one credit to the user. Atomic increment keeps the
 * final balance equal to (initial - successful calls), never negative. */
async function refundCredit(userId: string): Promise<void> {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { credits: { increment: 1 } },
    });
  } catch (err) {
    // If the refund itself fails the database is unhealthy; log loudly so
    // the loss is visible instead of silently dropping the credit.
    console.error(`Failed to refund credit for user ${userId}`, err);
  }
}

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

