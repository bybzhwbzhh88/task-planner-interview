import { useAuth } from "wasp/client/auth";
import { Navigate } from "react-router";
import { type Task } from "wasp/entities";

import {
  createTask,
  deleteTask,
  generatePlan,
  getAllTasksByUser,
  updateTask,
  useQuery,
} from "wasp/client/operations";

import { Loader2, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
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
  const auth = useAuth();
  const authStatus = (auth.error as { statusCode?: number } | null)?.statusCode;
  const authRejected = authStatus === 401 || authStatus === 403;
  if (!auth.data && !auth.isLoading && !auth.isError) {
    return <Navigate to="/login" replace />;
  }
  if (!auth.data || authRejected) {
    return <div className="p-6" role="status">
      {auth.isError
        ? <><p>{authRejected ? "登录状态已失效，请退出后重新登录。" : "暂时无法确认登录状态，请刷新后重试。"}</p><Button type="button" onClick={() => void auth.refetch()}>刷新登录状态</Button></>
        : "正在确认登录状态…"}
    </div>;
  }
  // Cached identity preserves the successful view during refresh errors only.
  // Every operation still authenticates on the server; stale credits never admit a request.
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
  const [description, setDescription] = useState("");
  const [todaysHours, setTodaysHours] = useState(8);
  const [response, setResponse] = useState<GeneratedSchedule | null>(null);
  const [isPreviousResult, setIsPreviousResult] = useState(false);
  const [isPlanGenerating, setIsPlanGenerating] = useState(false);
  const [feedback, setFeedback] = useState("");
  const auth = useAuth();
  const { data: tasks, isLoading: isTasksLoading, isError: isTasksError, refetch: refetchTasks } =
    useQuery(getAllTasksByUser);

  const handleSubmit = async () => {
    try {
      await handleCreateTask({ description });
      setDescription("");
    } catch {
      toast({ title: "添加失败", description: "请稍后重试。", variant: "destructive" });
    }
  };

  const handleGeneratePlan = async () => {
    if (isPlanGenerating) return;
    setIsPlanGenerating(true);
    setFeedback("");
    setIsPreviousResult(!!response);
    try {
      const result = await generatePlan({ hours: todaysHours });
      setResponse(result);
      setIsPreviousResult(false);
      setFeedback("生成成功，已消费 1 个额度。");
    } catch (error) {
      const failure = error as { statusCode?: number; data?: { code?: string; attemptId?: string; data?: { code?: string; attemptId?: string } } };
      const details = failure?.data?.data ?? failure?.data;
      const code = details?.code;
      let message = "结果暂无法确认，请刷新核对；仍不确定请保留请求编号反馈。";
      if (code === "PROVIDER_FAILED") message = "生成失败，额度已释放；请调整任务后重试。";
      else if (code === "SAVE_FAILED") message = "日程保存失败，额度已释放；请稍后重试。";
      else if (code === "DB_UNAVAILABLE") message = "服务暂不可用，本次未消费额度；请稍后重试。";
      else if (code === "NO_AVAILABLE_CREDIT" || failure?.statusCode === 402) {
        message = "当前没有可用额度；若其他页面正在生成，请完成后刷新。";
      } else if (failure?.statusCode === 401) message = "登录已失效，请重新登录后操作。";
      else if (failure?.statusCode === 400) message = "请添加任务，并将可用时长设为 1～24 小时。";
      if (details?.attemptId) message += " 请求编号：" + details.attemptId;
      setFeedback(message);
      toast({ title: "本次未完成", description: message, variant: "destructive" });
    } finally {
      // Refresh failures must not turn an already committed success into a failure.
      await auth.refetch().catch(() => undefined);
      setIsPlanGenerating(false);
    }
  };

  const noCredit = auth.data != null && auth.data.credits < 1;
  const invalidHours = !Number.isFinite(todaysHours) || todaysHours < 1 || todaysHours > 24;
  return (
    <div className="flex flex-col justify-center gap-6">
      <div className="flex items-center justify-between gap-3">
        <Input
          type="text" id="description" className="flex-1" placeholder="输入待办事项"
          value={description} onChange={(event) => setDescription(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && description) void handleSubmit(); }}
        />
        <Button type="button" onClick={handleSubmit} disabled={!description}>添加任务</Button>
      </div>

      {isTasksLoading ? <p>任务加载中…</p> : isTasksError ? (
        <p>任务读取失败。<button type="button" onClick={() => void refetchTasks()}>刷新任务</button></p>
      ) : tasks?.length ? (
        <div className="space-y-4">
          {tasks.map((task: Task) => <Todo key={task.id} {...task} />)}
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="todays-hours">今天可用的工作时长</Label>
            <Input type="number" id="todays-hours" min={1} max={24} step="any"
              className="min-w-28 text-center" value={todaysHours}
              onChange={(event) => setTodaysHours(event.currentTarget.valueAsNumber)} />
          </div>
          {invalidHours && <p role="alert">可用时长须为 1～24 小时。</p>}
        </div>
      ) : <p>请先添加待办事项</p>}

      <div className="text-muted-foreground space-y-2 text-sm">
        <p>生成时暂占 1 个额度，成功后消费，失败后释放。</p>
        {auth.isLoading && <p>可用额度加载中…</p>}
        {auth.isError && <p role="alert">无法确认可用额度，请刷新后再生成。</p>}
        {noCredit && <p data-testid="no-credit-message">当前没有可用额度；若其他页面正在生成，请完成后刷新。</p>}
        <Button type="button" variant="outline" onClick={() => void auth.refetch()}>刷新额度</Button>
      </div>

      <Button type="button"
        disabled={isPlanGenerating || isTasksLoading || isTasksError || !tasks?.length ||
          auth.isLoading || auth.isError || !auth.data || noCredit || invalidHours}
        onClick={() => void handleGeneratePlan()} className="w-full" data-testid="generate-schedule-button">
        {isPlanGenerating ? <><Loader2 className="mr-2 inline-block animate-spin" />生成中…</> : "生成日程"}
      </Button>
      <p role="status" aria-live="polite" data-testid="plan-feedback">{feedback}</p>
      {response && (
        <div className="flex flex-col">
          <h3 className="text-foreground mb-4 text-lg font-semibold" data-testid="schedule-heading">
            {isPreviousResult ? "上次成功生成的日程" : "本次日程"}
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
