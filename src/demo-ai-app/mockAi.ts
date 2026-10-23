import { randomUUID } from "node:crypto";
import type { Task } from "wasp/entities";
import type { GeneratedSchedule, TaskPriority } from "./schedule";

export class MockProviderError extends Error {}

/** Local provider fixture. Each invocation represents one billable provider call. */
export async function generateMockSchedule(
  tasks: Pick<Task, "description" | "time">[],
  hours: number,
): Promise<GeneratedSchedule> {
  const callId = randomUUID();
  console.info(JSON.stringify({ event: "mock-ai.started", callId }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (tasks.some((task) => task.description.includes("[fail]"))) {
    console.info(JSON.stringify({ event: "mock-ai.failed", callId }));
    throw new MockProviderError("Mock provider explicitly rejected the request");
  }
  const result = {
    tasks: tasks.map((task) => ({
      name: task.description,
      priority: "medium" as TaskPriority,
    })),
    taskItems: tasks.flatMap((task) =>
      ["准备", "执行", "复盘"].map((step) => ({
        description: `${step}: ${task.description}`,
        taskName: task.description,
        time: Number((hours / Math.max(tasks.length, 1) / 3).toFixed(2)),
      })),
    ),
  };
  console.info(JSON.stringify({ event: "mock-ai.succeeded", callId }));
  return result;
}
