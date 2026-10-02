import { z } from "zod";

export const stageSchema = z.enum([
  "PM",
  "BA",
  "TECH_LEAD",
  "BACKEND",
  "FRONTEND",
  "TESTER",
]);

export const stageStatusSchema = z.enum([
  "approved",
  "changes_requested",
  "blocked",
]);

export const reviewRequestSchema = z.object({
  role: stageSchema,
  reason: z.string(),
  questions: z.array(z.string()),
});

export const taskOwnerSchema = z.enum(["BACKEND", "FRONTEND"]);
export const taskStatusSchema = z.enum([
  "planned",
  "running",
  "reviewing",
  "testing",
  "done",
  "blocked",
]);

export const deliveryTaskSchema = z.object({
  id: z.string(),
  phase: z.string(),
  sprint: z.string(),
  title: z.string(),
  owner: taskOwnerSchema,
  dependsOn: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  status: taskStatusSchema.default("planned"),
});

export const stageResultSchema = z.object({
  stage: stageSchema,
  status: stageStatusSchema,
  summary: z.string(),
  artifact: z.string(),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  filesChanged: z.array(z.string()),
  tests: z.array(z.string()),
  reviewRequests: z.array(reviewRequestSchema).default([]),
  tasks: z.array(deliveryTaskSchema).default([]),
});

export type Stage = z.infer<typeof stageSchema>;
export type StageResult = z.infer<typeof stageResultSchema>;
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;
export type DeliveryTask = z.infer<typeof deliveryTaskSchema>;
export type TaskOwner = z.infer<typeof taskOwnerSchema>;

export type ProjectInput = {
  request: string;
  repositoryContext?: string;
  constraints?: string[];
};
