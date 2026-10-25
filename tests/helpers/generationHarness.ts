import { vi } from "vitest";
import type { StoredPlan } from "../../src/demo-ai-app/generation";
import type { GenerationDependencies, GenerationStore } from "../../src/demo-ai-app/planGeneration";

/** 编排层单元测试替身：不连数据库，也不调用真实模拟接口。 */
export function createGenerationHarness() {
  const plan: StoredPlan = {
    id: "request-1",
    createdAt: "2026-10-23T00:00:00.000Z",
    schedule: {
      tasks: [{ name: "写周报", priority: "medium" }],
      taskItems: [{ description: "完成周报", time: 8, taskName: "写周报" }],
    },
  };

  const store = {
    listTasks: vi.fn(async () => [{ description: "写周报", time: "1" }]),
    reserve: vi.fn(async () => true),
    save: vi.fn(async () => plan),
    findPlan: vi.fn(async (): Promise<StoredPlan | null> => null),
    refund: vi.fn(async () => undefined),
    getCredits: vi.fn(async () => 2),
  } satisfies GenerationStore;

  const deps: GenerationDependencies = {
    store,
    generate: vi.fn(async () => plan.schedule),
    newRequestId: vi.fn(() => "request-1"),
    log: vi.fn(),
  };

  return { deps, store, plan, userId: "user-1" };
}
