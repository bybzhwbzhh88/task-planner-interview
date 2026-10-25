import { expect, it } from "vitest";
import { pickNewestPlan } from "../../src/demo-ai-app/generation";
const plan = (id: string, day: number) => ({ id, createdAt: new Date(`2026-10-${day}T00:00:00Z`), schedule: { tasks: [], taskItems: [] } });
it("刷新查询的新结果取代本地旧结果", () => {
  expect(pickNewestPlan(plan("a", 22), plan("b", 23))?.id).toBe("b");
});
it("查询暂不可用仍保留本次确认成功的结果", () => {
  expect(pickNewestPlan(plan("a", 23), undefined)?.id).toBe("a");
});
it("本地较新结果不会被旧查询覆盖", () => {
  expect(pickNewestPlan(plan("b", 23), plan("a", 22))?.id).toBe("b");
});
it("同时间按ID确定顺序，与数据库查询一致", () => {
  expect(pickNewestPlan(plan("a", 23), plan("b", 23))?.id).toBe("b");
});
