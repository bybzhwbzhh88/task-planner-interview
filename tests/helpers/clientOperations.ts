import { vi } from "vitest";

// UI tests use real page/components and replace only the network/query boundary.
export const createTask = vi.fn();
export const deleteTask = vi.fn();
export const generatePlan = vi.fn();
export const getAllTasksByUser = vi.fn();
export const getCredits = vi.fn();
export const getPlanResults = vi.fn();
export const updateTask = vi.fn();
export const useQuery = vi.fn();
