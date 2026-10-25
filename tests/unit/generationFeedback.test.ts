import { expect, it } from "vitest";
import { generationFeedback } from "../../src/demo-ai-app/generationFeedback";

it("成功明确告知消费一个额度", () => {
  expect(generationFeedback({ status: "succeeded" }).message).toContain("消耗 1");
});
it.each(["MODEL_FAILED_REFUNDED", "SAVE_FAILED_REFUNDED"])("已确认返还 %s 可以重试", code => {
  expect(generationFeedback({ status: "failed", code, requestId: "req-123" }).message).toMatch(/未消耗.*重试/);
});
it("未知结算不误导为已返还，且提供编号和核对操作", () => {
  const feedback = generationFeedback({ status: "failed", code: "SETTLEMENT_UNKNOWN", requestId: "req-123" });
  expect(feedback.message).toContain("req-123");
  expect(feedback.message).toContain("刷新");
  expect(feedback.message).not.toMatch(/未消耗|已返还|重试生成/);
});
it("额度不足说明没有发起调用", () => {
  expect(generationFeedback({ statusCode: 402 }).message).toContain("未调用模型");
});
it("未登录给出重新登录下一步", () => {
  expect(generationFeedback({ statusCode: 401 }).message).toContain("重新登录");
});
it("网络故障不声称未扣费或引导重新生成", () => {
  const { message } = generationFeedback(new Error("network"));
  expect(message).toMatch(/刷新.*最近日程/);
  expect(message).not.toMatch(/未消耗|已返还|重试生成/);
});
