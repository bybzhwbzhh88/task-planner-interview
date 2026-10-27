import { type Task } from "wasp/entities";

import {
  createTask,
  deleteTask,
  generatePlan,
  getAllTasksByUser,
  getCreditBalance,
  updateTask,
  useQuery,
} from "wasp/client/operations";

import { Loader2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../client/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../client/components/ui/card";
import { Checkbox } from "../client/components/ui/checkbox";
import { Input } from "../client/components/ui/input";
import { Label } from "../client/components/ui/label";
import { cn } from "../client/utils";
import type { GeneratePlanResult } from "./generate-plan";
import type {
  GeneratedSchedule,
  Task as ScheduleTask,
  TaskItem,
  TaskPriority,
} from "./schedule";

export function DemoAppPage() {
  return (
    <div className="py-10 lg:mt-10">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="text-foreground mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            <span className="text-primary">AI</span> 任务规划
          </h2>
        </div>
        <p className="text-muted-foreground mx-auto mt-6 max-w-2xl text-center text-lg leading-8">
          输入待办事项和可用时长，生成一份模拟日程。本页面使用本地接口，无需 API Key。
        </p>
        {/* begin AI-powered Todo List */}
        <Card className="bg-muted/10 my-8">
          <CardContent className="mx-auto my-8 space-y-10 px-6 py-10 sm:w-[90%] md:w-[70%] lg:w-[50%]">
            <NewTaskForm handleCreateTask={createTask} />
          </CardContent>
        </Card>
        {/* end AI-powered Todo List */}
      </div>
    </div>
  );
}

type PlanFeedback = {
  kind: "success" | "error";
  title: string;
  detail: string;
};

function getErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return undefined;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function NewTaskForm({
  handleCreateTask,
}: {
  handleCreateTask: typeof createTask;
}) {
  const [description, setDescription] = useState<string>("");
  const [todaysHours, setTodaysHours] = useState<number>(8);
  const [response, setResponse] = useState<GeneratedSchedule | null>(null);
  const [isPlanGenerating, setIsPlanGenerating] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<PlanFeedback | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const generatingRef = useRef(false);

  const { data: tasks, isLoading: isTasksLoading } =
    useQuery(getAllTasksByUser);
  const {
    data: creditBalance,
    isLoading: isCreditLoading,
    refetch: refetchCreditBalance,
  } = useQuery(getCreditBalance);

  useEffect(() => {
    if (creditBalance) {
      setCredits(creditBalance.credits);
    }
  }, [creditBalance]);

  const isOutOfCredits = credits === 0;

  const handleSubmit = async () => {
    try {
      await handleCreateTask({ description });
      setDescription("");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong";
      window.alert("Error: " + message);
    }
  };

  const handleGeneratePlan = async () => {
    // Prevent a double click from sending two requests before re-render.
    if (generatingRef.current || isOutOfCredits) {
      return;
    }
    generatingRef.current = true;
    setIsPlanGenerating(true);
    setFeedback(null);

    try {
      const result: GeneratePlanResult = await generatePlan({
        hours: todaysHours,
      });
      setResponse(result.schedule);
      setCredits(result.remainingCredits);
      setFeedback({
        kind: "success",
        title: "日程已生成",
        detail: `本次消耗 1 个额度，剩余 ${result.remainingCredits} 个。`,
      });
    } catch (err) {
      const statusCode = getErrorStatusCode(err);
      if (statusCode === 402) {
        setCredits(0);
        setFeedback({
          kind: "error",
          title: "额度不足，本次未生成日程",
          detail:
            "没有调用模型，也没有扣费。请联系管理员补充额度，或使用新账号。",
        });
        // A concurrent failure may have refunded a credit; re-read the real balance.
        void refetchCreditBalance?.();
      } else if (statusCode === 502) {
        setFeedback({
          kind: "error",
          title: "模型未通过本次请求，未扣额度",
          detail:
            "请删除包含 [fail] 的任务后重试；也可以调整任务内容再生成。",
        });
      } else if (statusCode === 400) {
        setFeedback({
          kind: "error",
          title: "请求参数有误，本次未生成日程",
          detail: "请检查可用工作时长后重试。本次没有扣额度。",
        });
      } else if (statusCode === 401) {
        setFeedback({
          kind: "error",
          title: "登录状态已失效",
          detail: "请重新登录后再生成日程。",
        });
      } else {
        setFeedback({
          kind: "error",
          title: "生成失败，未生成日程",
          detail:
            "若已预占额度，系统会自动退回；如果余额减少，请联系管理员核对。",
        });
        // Reflect a refund if the failure happened after reservation.
        void refetchCreditBalance?.();
      }
    } finally {
      generatingRef.current = false;
      setIsPlanGenerating(false);
    }
  };

  return (
    <div className="flex flex-col justify-center gap-10">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <Input
            type="text"
            id="description"
            className="flex-1"
            placeholder="输入待办事项"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSubmit();
              }
            }}
          />
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!description}
            variant="default"
            size="default"
          >
            添加任务
          </Button>
        </div>
      </div>

      <div className="col-span-full space-y-10">
        {isTasksLoading && (
          <div className="text-muted-foreground">Loading...</div>
        )}
        {tasks! && tasks.length > 0 ? (
          <div className="space-y-4">
            {tasks.map((task: Task) => (
              <Todo
                key={task.id}
                id={task.id}
                isDone={task.isDone}
                description={task.description}
                time={task.time}
              />
            ))}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <Label
                  htmlFor="time"
                  className="text-muted-foreground text-nowrap text-sm font-semibold"
                >
                  今天可用的工作时长
                </Label>
                <Input
                  type="number"
                  id="time"
                  step={0.5}
                  min={1}
                  max={24}
                  className="min-w-28 text-center"
                  value={todaysHours}
                  onChange={(e) => setTodaysHours(+e.currentTarget.value)}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="text-muted-foreground text-center">
            请先添加待办事项
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          每成功生成一次日程消耗 1 个额度。
        </p>
        <span
          className={cn(
            "rounded-full border px-3 py-1 text-sm font-semibold",
            isOutOfCredits
              ? "border-destructive/30 text-destructive"
              : "border-border text-foreground",
          )}
          data-testid="credit-balance"
          aria-live="polite"
        >
          {isCreditLoading || credits === null
            ? "额度加载中…"
            : `剩余额度：${credits}`}
        </span>
      </div>

      <Button
        type="button"
        disabled={isPlanGenerating || tasks?.length === 0 || isOutOfCredits}
        onClick={() => handleGeneratePlan()}
        variant="default"
        size="default"
        className="w-full"
        data-testid="generate-schedule-button"
      >
        {isPlanGenerating ? (
          <>
            <Loader2 className="mr-2 inline-block animate-spin" />
            生成中…
          </>
        ) : isOutOfCredits ? (
          "额度已用完"
        ) : (
          "生成日程"
        )}
      </Button>

      {isOutOfCredits && (
        <p className="text-destructive text-sm" data-testid="out-of-credits">
          额度已用完，生成按钮已停用。请联系管理员补充额度，或使用新账号。
        </p>
      )}

      {feedback && (
        <div
          role="status"
          aria-live="polite"
          data-testid="plan-feedback"
          className={cn(
            "rounded-md border p-4 text-sm",
            feedback.kind === "success"
              ? "border-success/30 bg-success/10"
              : "border-destructive/30 bg-destructive/10",
          )}
        >
          <p className="font-semibold">{feedback.title}</p>
          <p className="text-muted-foreground mt-1">{feedback.detail}</p>
        </div>
      )}

      {!!response && (
        <div className="flex flex-col">
          <h3 className="text-foreground mb-4 text-lg font-semibold">
            本次日程
          </h3>
          <Schedule schedule={response} />
        </div>
      )}
    </div>
  );
}

type TodoProps = Pick<Task, "id" | "isDone" | "description" | "time">;

function Todo({ id, isDone, description, time }: TodoProps) {
  const handleCheckboxChange = async (checked: boolean) => {
    await updateTask({
      id,
      isDone: checked,
    });
  };

  const handleTimeChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await updateTask({
      id,
      time: e.currentTarget.value,
    });
  };

  const handleDeleteClick = async () => {
    await deleteTask({ id });
  };

  return (
    <Card className="p-4">
      <div className="flex w-full items-center justify-between">
        <div className="flex w-full items-center justify-between gap-5">
          <div className="flex items-center gap-3">
            <Checkbox
              checked={isDone}
              onCheckedChange={handleCheckboxChange}
              className="data-[state=checked]:bg-primary data-[state=checked]:border-primary"
            />
            <span
              className={cn("text-foreground", {
                "text-muted-foreground line-through": isDone,
              })}
            >
              {description}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="time"
              type="number"
              min={0.5}
              step={0.5}
              className={cn("w-18 h-8 text-center text-xs", {
                "pointer-events-none opacity-50": isDone,
              })}
              value={time}
              onChange={handleTimeChange}
            />
            <span
              className={cn("text-muted-foreground text-xs italic", {
                "text-muted-foreground": isDone,
              })}
            >
              小时
            </span>
          </div>
        </div>
        <div className="w-15 flex items-center justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDeleteClick}
            title="删除任务"
            className="text-destructive hover:text-destructive/80 h-auto p-1"
          >
            <Trash2 size="20" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Schedule({ schedule }: { schedule: GeneratedSchedule }) {
  return (
    <div className="flex flex-col gap-6 py-6" data-testid="schedule">
      <div className="space-y-4">
        {schedule.tasks ? (
          schedule.tasks
            .map((task) => (
              <TaskCard
                key={task.name}
                task={task}
                taskItems={schedule.taskItems}
              />
            ))
            .sort((a, b) => {
              const priorityOrder: TaskPriority[] = ["low", "medium", "high"];
              if (a.props.task.priority && b.props.task.priority) {
                return (
                  priorityOrder.indexOf(b.props.task.priority) -
                  priorityOrder.indexOf(a.props.task.priority)
                );
              } else {
                return 0;
              }
            })
        ) : (
          <div className="text-muted-foreground text-center">
            接口未返回任务，请重试。
          </div>
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  taskItems,
}: {
  task: ScheduleTask;
  taskItems: TaskItem[];
}) {
  const taskPriorityToColorMap: Record<TaskPriority, string> = {
    high: "bg-destructive/10 border-destructive/20 text-red-500",
    medium: "bg-warning/10 border-warning/20 text-warning",
    low: "bg-success/10 border-success/20 text-success",
  };

  return (
    <Card className={cn("border-2", taskPriorityToColorMap[task.priority])}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span>{task.name}</span>
          <span className="text-xs font-medium italic">
            {" "}
            {{ high: "高优先级", medium: "中优先级", low: "低优先级" }[task.priority]}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {taskItems ? (
          <ul className="space-y-2">
            {taskItems.map((taskItem) => {
              if (taskItem.taskName === task.name) {
                return (
                  <TaskCardItem key={taskItem.description} {...taskItem} />
                );
              }
              return null;
            })}
          </ul>
        ) : (
          <div className="text-muted-foreground text-center">
            接口未返回任务明细，请重试。
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TaskCardItem({ description, time }: TaskItem) {
  const [isDone, setIsDone] = useState<boolean>(false);

  const formattedTime = useMemo(() => {
    if (time === 0) return "0分钟";
    const hours = Math.floor(time);
    const minutes = Math.round((time - hours) * 60);

    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分钟`);

    return parts.join(" ");
  }, [time]);

  const handleCheckedChange = (checked: boolean | "indeterminate") => {
    setIsDone(checked === true);
  };

  return (
    <li className="flex items-center justify-between gap-4 rounded-md p-2">
      <div className="flex flex-1 items-center gap-3">
        <Checkbox
          checked={isDone}
          onCheckedChange={handleCheckedChange}
          className="data-[state=checked]:bg-primary data-[state=checked]:border-primary"
        />
        <span
          className={cn("text-sm leading-tight", {
            "text-muted-foreground line-through opacity-50": isDone,
          })}
        >
          {description}
        </span>
      </div>
      <span
        className={cn("text-muted-foreground text-sm", {
          "line-through opacity-50": isDone,
        })}
      >
        {formattedTime}
      </span>
    </li>
  );
}
