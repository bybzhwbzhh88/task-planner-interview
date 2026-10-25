import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../client/components/ui/card";
import { Checkbox } from "../client/components/ui/checkbox";
import { cn } from "../client/utils";
import type { GeneratedSchedule, Task as ScheduleTask, TaskItem, TaskPriority } from "./schedule";

export function Schedule({ schedule }: { schedule: GeneratedSchedule }) {
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
