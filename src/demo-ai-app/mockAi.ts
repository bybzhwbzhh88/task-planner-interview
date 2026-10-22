import type { Task } from "wasp/entities";
import type { GeneratedSchedule, TaskPriority } from "./schedule";

/**
 * Local provider fixture. Each invocation represents one billable provider call.
 *
 * `callId` 改由调用方传入，好让 `credits.*` 与 `mock-ai.*` 日志用同一个 id 串起来
 * （SPEC §4.4）。除此之外行为不变：仍然是 500ms 延迟，任务含 `[fail]` 时明确失败。
 */
export async function generateMockSchedule(
  tasks: Pick<Task, "description" | "time">[],
  hours: number,
  callId: string,
): Promise<GeneratedSchedule> {
  console.info(JSON.stringify({ event: "mock-ai.started", callId }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (tasks.some((task) => task.description.includes("[fail]"))) {
    console.info(JSON.stringify({ event: "mock-ai.failed", callId }));
    throw new Error("Mock provider explicitly rejected the request");
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
