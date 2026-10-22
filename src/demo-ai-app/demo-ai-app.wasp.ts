import { action, page, query, route, type Spec } from "@wasp.sh/spec";

import { DemoAppPage } from "./DemoAppPage" with { type: "ref" };
import {
  createTask,
  deleteTask,
  generatePlan,
  getAllTasksByUser,
  getMyCredits,
  getPlanResults,
  updateTask,
} from "./operations" with { type: "ref" };

export const demoAiAppSpec: Spec = [
  route("DemoAppRoute", "/demo-app", page(DemoAppPage, { authRequired: true })),

  query(getPlanResults, { entities: ["User", "PlanResult"] }),
  query(getMyCredits, { entities: ["User"] }),
  action(generatePlan, { entities: ["User", "Task", "PlanResult"] }),

  query(getAllTasksByUser, { entities: ["Task"] }),
  action(createTask, { entities: ["Task"] }),
  action(updateTask, { entities: ["Task"] }),
  action(deleteTask, { entities: ["Task"] }),
];
