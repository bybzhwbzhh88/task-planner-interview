import { type Task } from "wasp/entities";

import {
  createTask,
  deleteTask,
  generatePlan,
  getAllTasksByUser,
  getCredits,
  updateTask,
  useQuery,
} from "wasp/client/operations";

import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { toast } from "../client/hooks/use-toast";
import { cn } from "../client/utils";
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

function NewTaskForm({
  handleCreateTask,
}: {
  handleCreateTask: typeof createTask;
}) {
  const [description, setDescription] = useState<string>("");
  const [todaysHours, setTodaysHours] = useState<number>(8);
  const [response, setResponse] = useState<GeneratedSchedule | null>(null);
  const [isPlanGenerating, setIsPlanGenerating] = useState<boolean>(false);

  const {
    data: tasks,
    isLoading: isTasksLoading,
    error: tasksError,
    refetch: refetchTasks,
  } = useQuery(getAllTasksByUser);
  const isTasksError = Boolean(tasksError);

  const {
    data: credits,
    isLoading: isCreditsLoading,
    error: creditsError,
    refetch: refetchCredits,
  } = useQuery(getCredits);
  const isCreditsError = Boolean(creditsError);

  useEffect(() => {
    const handleFocus = () => {
      refetchCredits().catch(() => undefined);
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refetchCredits]);

  const isHoursValid =
    Number.isFinite(todaysHours) && todaysHours >= 1 && todaysHours <= 24;

  const disabledReason = (() => {
    if (isPlanGenerating) return "正在生成，请稍候…";
    if (isTasksLoading) return "任务加载中…";
    if (isTasksError) return "任务加载失败，请刷新重试。";
    if (!tasks || tasks.length === 0) return "请先添加待办事项。";
    if (isCreditsLoading) return "额度加载中…";
    if (isCreditsError) return "额度读取失败，请刷新重试。";
    if (credits === undefined) return "额度加载中…";
    if (credits <= 0) return "额度不足，本练习暂不提供充值。";
    if (!isHoursValid) return "工作时长需在 1–24 小时之间。";
    return null;
  })();

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
    try {
      setIsPlanGenerating(true);
      const generatedSchedule = await generatePlan({
        hours: todaysHours,
      });
      setResponse(generatedSchedule);
      toast({
        title: "生成成功",
        description: "已消耗 1 个额度。",
      });
    } catch (err) {
      const statusCode = getStatusCode(err);
      if (statusCode === 402) {
        toast({
          title: "额度不足",
          style: {
            minWidth: "400px",
          },
          description: "无法生成。可继续编辑任务；本练习暂不提供充值。",
        });
      } else if (statusCode === 502) {
        toast({
          title: "生成失败",
          description:
            "模拟生成失败，本次未扣费。请删除含 [fail] 的任务后重试。",
          variant: "destructive",
        });
      } else if (statusCode === 400) {
        toast({
          title: "输入不合法",
          description: "请检查工作时长（1–24 小时）或先添加任务。",
          variant: "destructive",
        });
      } else {
        toast({
          title: "暂时无法确认结果",
          description: "请先刷新额度并核对后再操作。",
          variant: "destructive",
        });
      }
    } finally {
      setIsPlanGenerating(false);
      refetchCredits().catch(() => undefined);
    }
  };

  const creditsLabel =
    isCreditsLoading || isCreditsError || credits === undefined
      ? "—"
      : credits;

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
        {isTasksError && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">
              任务加载失败，请刷新重试。
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => refetchTasks().catch(() => undefined)}
            >
              重新加载
            </Button>
          </div>
        )}
        {tasks && tasks.length > 0 ? (
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
          !isTasksLoading &&
          !isTasksError && (
            <div className="text-muted-foreground text-center">
              请先添加待办事项
            </div>
          )
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <span
          className="text-muted-foreground text-sm"
          data-testid="credits-balance"
        >
          剩余额度：{creditsLabel}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => refetchCredits().catch(() => undefined)}
          disabled={isCreditsLoading}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          刷新额度
        </Button>
      </div>

      {isCreditsError && (
        <p className="text-destructive text-sm">额度读取失败，请刷新重试。</p>
      )}

      <Button
        type="button"
        disabled={disabledReason !== null}
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
        ) : (
          "生成日程"
        )}
      </Button>

      {disabledReason && (
        <p
          className="text-muted-foreground text-center text-sm"
          data-testid="generate-disabled-reason"
        >
          {disabledReason}
        </p>
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

function getStatusCode(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    return typeof statusCode === "number" ? statusCode : undefined;
  }

  return undefined;
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
