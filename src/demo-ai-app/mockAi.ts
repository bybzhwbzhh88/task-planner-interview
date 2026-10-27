import { randomUUID } from "node:crypto";
import type { GeneratedSchedule, TaskPriority } from "./schedule";

export type MockAiTask = {
  description: string;
  time: string;
};

/**
 * Must stay in sync with MODEL_REJECTED_CODE in generate-plan.ts.
 * The orchestration layer duck-types on `code` to keep the core testable
 * without importing the provider at runtime.
 */
export const MOCK_AI_REJECTED_CODE = "MOCK_AI_REJECTED";

export class MockAiRejectedError extends Error {
  readonly code = MOCK_AI_REJECTED_CODE;

  constructor(callId: string) {
    super(`Mock provider explicitly rejected the request (callId: ${callId})`);
    this.name = "MockAiRejectedError";
  }
}

/** Local provider fixture. Each invocation represents one billable provider call. */
export async function generateMockSchedule(
  tasks: MockAiTask[],
  hours: number,
): Promise<GeneratedSchedule> {
  const callId = randomUUID();
  console.info(JSON.stringify({ event: "mock-ai.started", callId }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (tasks.some((task) => task.description.includes("[fail]"))) {
    console.info(JSON.stringify({ event: "mock-ai.failed", callId }));
    throw new MockAiRejectedError(callId);
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
