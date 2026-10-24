import { type Task } from "wasp/entities";
import { quotaFeedback } from "./quotaFeedback";
import { refreshQuotaResults } from "./quotaRefresh";

import {
  createTask,
  deleteTask,
  generatePlan,
  getAllTasksByUser,
  getQuota,
  getPlanResults,
  updateTask,
  useQuery,
} from "wasp/client/operations";

import { Loader2, Trash2 } from "lucide-react";
import { useMemo, useState, useRef } from "react";
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

  const [message, setMessage] = useState("");
  const [isPrevious, setIsPrevious] = useState(false);
  const generating = useRef(false);
  const refreshing = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const quota = useQuery(getQuota, undefined, {
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    retry: false,
  });
  const results = useQuery(getPlanResults, undefined, { enabled: false, retry: false });
  const refresh = async () => {
    if (generating.current || refreshing.current) return;
    refreshing.current = true;
    setIsRefreshing(true);
    try {
      await refreshQuotaResults({
        loadQuota: () => quota.refetch(),
        loadResults: () => results.refetch(),
        onResult: (saved) => {
          setResponse(saved);
          setIsPrevious(true);
        },
        onMessage: setMessage,
      });
    } finally {
      refreshing.current = false;
      setIsRefreshing(false);
    }
  };

  const { data: tasks, isLoading: isTasksLoading, isError: isTasksError } =
    useQuery(getAllTasksByUser);

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
    if (generating.current || refreshing.current) return;
    generating.current = true;
    setIsPlanGenerating(true);
    setIsPrevious(true);
    setMessage("生成中，额度将暂时占用…");
    try {
      const generated = await generatePlan({ hours: todaysHours });
      setResponse(generated);
      setIsPrevious(false);
      setMessage("生成成功，消耗 1 次额度。");
    } catch (err) {
      const feedback = quotaFeedback(err);
      setMessage(feedback.message + (feedback.requestId ? ` 请求编号：${feedback.requestId}` : ""));
      toast({ title: feedback.code === "QUOTA_EXHAUSTED" ? "额度不足" : "生成未完成", description: feedback.message });
    } finally {
      await quota.refetch();
      generating.current = false;
      setIsPlanGenerating(false);
    }
  };

  return (
    <div className="flex flex-col justify-center gap-10">
      <div className="space-y-2" aria-label="额度信息">
        <p>可用额度：{quota.data ? `${quota.data.availableCredits} 次` : "读取中…"}</p>
        <p className="text-sm text-muted-foreground">成功生成消耗 1 次；失败不消耗。</p>
        {!!quota.data?.processingCount && <p>处理中 {quota.data.processingCount} 次，相关额度暂时占用。</p>}
        {quota.data?.availableCredits === 0 && <p>当前无可用额度；如有处理中请求，请等待完成后刷新。</p>}
        {quota.isError && <p role="alert">额度读取失败，请刷新额度。</p>}
        <Button type="button" variant="outline" onClick={() => void refresh()} disabled={isPlanGenerating || isRefreshing || quota.isFetching}>刷新额度与最近结果</Button>
        {message && <p role="status">{message}</p>}
      </div>
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

      <Button
        type="button"
        disabled={isPlanGenerating || isRefreshing || isTasksLoading || isTasksError || !tasks?.length || quota.isLoading || quota.isError || !quota.data || quota.data.availableCredits <= 0 || !Number.isFinite(todaysHours) || todaysHours < 1 || todaysHours > 24 || todaysHours * 2 % 1 !== 0}
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

      {!!response && (
        <div className="flex flex-col">
          <h3 className="text-foreground mb-4 text-lg font-semibold">
            {isPrevious ? "上次成功生成" : "本次日程"}
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
