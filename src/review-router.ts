import type { ReviewRequest, Stage, StageResult } from "./contracts.js";

export const deliveryStages: Stage[] = [
  "PM",
  "BA",
  "TECH_LEAD",
  "BACKEND",
  "FRONTEND",
  "TESTER",
];

export const defaultReviewTargets: Partial<Record<Stage, Stage[]>> = {
  BA: ["PM"],
  TECH_LEAD: ["BA"],
  BACKEND: ["TECH_LEAD"],
  FRONTEND: ["TECH_LEAD"],
  TESTER: ["TECH_LEAD"],
};

export type ReviewFeedback = {
  requestedBy: Stage;
  requests: ReviewRequest[];
  sourceResult: StageResult;
  responses: Partial<Record<Stage, StageResult>>;
  previousResult?: StageResult;
};

export function stageIndex(stage: Stage): number {
  return deliveryStages.indexOf(stage);
}

export function reviewRequestsFor(
  stage: Stage,
  result: StageResult,
): ReviewRequest[] {
  const currentIndex = stageIndex(stage);
  const explicit = result.reviewRequests.filter(
    (request) =>
      stageIndex(request.role) >= 0 && stageIndex(request.role) < currentIndex,
  );
  if (explicit.length > 0) {
    return [...new Map(explicit.map((request) => [request.role, request])).values()];
  }

  const fallbackTargets = defaultReviewTargets[stage] ?? [];
  if (fallbackTargets.length === 0) {
    throw new Error(
      `${stage} needs a decision but did not identify an earlier role in reviewRequests: ${result.summary}`,
    );
  }

  return fallbackTargets.map((role) => ({
    role,
    reason: `${stage} needs the earlier role to review the unresolved result.`,
    questions:
      result.openQuestions.length > 0 ? result.openQuestions : [result.summary],
  }));
}

export function finalCodeReviewRequests(result: StageResult): ReviewRequest[] {
  const codeOwners = new Set<Stage>(["BACKEND", "FRONTEND"]);
  const explicit = result.reviewRequests.filter((request) =>
    codeOwners.has(request.role),
  );
  if (explicit.length > 0) {
    return [...new Map(explicit.map((request) => [request.role, request])).values()];
  }

  if (result.status === "blocked") {
    throw new Error(
      `TECH_LEAD final review is blocked and did not identify a Backend or Frontend owner: ${result.summary}`,
    );
  }

  return ["BACKEND", "FRONTEND"].map((role) => ({
    role: role as Stage,
    reason: "Final TECH_LEAD review found code that needs the code owner to inspect.",
    questions:
      result.openQuestions.length > 0 ? result.openQuestions : [result.summary],
  }));
}
