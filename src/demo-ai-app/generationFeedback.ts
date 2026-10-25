export type GenerationFeedback = { title: string; message: string; tone: "success" | "error" | "warning" };

/** Do not infer settlement from transport success/failure. */
export function generationFeedback(value: unknown): GenerationFeedback {
  const result = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (result.status === "succeeded") return { title: "日程已生成", message: "本次消耗 1 个额度。可用额度以最新查询为准。", tone: "success" };
  if (result.code === "MODEL_FAILED_REFUNDED") return { title: "模拟接口生成失败", message: "本次未消耗额度，可以重试；若任务包含 [fail]，请修改或删除该任务后再试。", tone: "error" };
  if (result.code === "SAVE_FAILED_REFUNDED") return { title: "日程保存失败", message: "本次未消耗额度，可以重试。", tone: "error" };
  if (result.code === "SETTLEMENT_UNKNOWN") return { title: "结算状态待确认", message: `请先刷新额度与最近日程，再凭请求编号核对：${String(result.requestId)}。暂时不要再次生成。`, tone: "warning" };
  if (result.statusCode === 402) return { title: "没有可用额度", message: "本次未调用模型。若有日程正在生成，请等待结束后刷新额度。", tone: "warning" };
  if (result.statusCode === 401) return { title: "登录已失效", message: "请重新登录后查看额度和最近日程。", tone: "warning" };
  if (result.statusCode === 400) return { title: "请检查任务与时长", message: "请添加任务并输入 1–24 小时的有效时长，本次未消耗额度。", tone: "warning" };
  return { title: "暂未确认操作结果", message: "请先刷新额度与最近日程，确认结果后再决定下一步。", tone: "warning" };
}
