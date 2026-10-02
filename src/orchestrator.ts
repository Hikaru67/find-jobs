import { mkdir, writeFile } from "node:fs/promises";
import { run } from "@openai/agents";

import {
  loadPipelineCheckpoint,
  savePipelineCheckpoint,
} from "./checkpoint.js";
import {
  stageResultSchema,
  type ProjectInput,
  type Stage,
  type StageResult,
} from "./contracts.js";
import { agents, type StageAgent } from "./agents.js";
import {
  deliveryStages,
  finalCodeReviewRequests,
  reviewRequestsFor,
  stageIndex,
  type ReviewFeedback,
} from "./review-router.js";

const artifactsDirectory = new URL("../artifacts/", import.meta.url);

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function saveArtifact(
  stage: Stage,
  result: StageResult,
  artifactFile = `${stage.toLowerCase()}.json`,
): Promise<void> {
  await mkdir(artifactsDirectory, { recursive: true });
  await writeFile(
    new URL(artifactFile, artifactsDirectory),
    `${serialize(result)}\n`,
    "utf8",
  );
}

async function runStage(
  stage: Stage,
  agent: StageAgent,
  input: unknown,
  options: { finalReview?: boolean; artifactFile?: string } = {},
): Promise<StageResult> {
  const finalReviewInstructions = options.finalReview
    ? `
This is the mandatory final TECH_LEAD code review before merge. Inspect the actual
Backend and Frontend changes in read-only mode. Approve only when the implementation
matches the approved requirements and technical contract and is safe to merge. If
fixes are needed, route reviewRequests to BACKEND and/or FRONTEND.
`
    : "";
  const result = await run(
    agent,
    `${finalReviewInstructions}\n${serialize(input)}`,
  );
  const parsed = stageResultSchema.parse(result.finalOutput);

  await saveArtifact(stage, parsed, options.artifactFile);

  return parsed;
}

function requireApproved(stage: Stage, result: StageResult): StageResult {
  if (result.status !== "approved") {
    throw new Error(
      `${stage} stopped with status ${result.status}: ${result.summary}`,
    );
  }
  return result;
}

function reuseStage(stage: Stage, result: StageResult): StageResult {
  console.error(`[${stage}] reusing approved checkpoint`);
  return result;
}

export async function runDeliveryPipeline(
  project: ProjectInput,
): Promise<Record<Stage, StageResult>> {
  const checkpointResults = await loadPipelineCheckpoint(project);
  const results: Partial<Record<Stage, StageResult>> = checkpointResults;
  const extraArtifacts: Record<string, unknown> = {};

  const persist = async (stage: Stage, result: StageResult) => {
    results[stage] = result;
    checkpointResults[stage] = result;
    await savePipelineCheckpoint(project, checkpointResults);
  };

  const invalidateFrom = async (stage: Stage): Promise<void> => {
    for (const downstream of deliveryStages.slice(stageIndex(stage))) {
      delete results[downstream];
      delete checkpointResults[downstream];
    }
    await savePipelineCheckpoint(project, checkpointResults);
  };
  const agentsByStage: Record<Stage, StageAgent> = {
    PM: agents.pm,
    BA: agents.ba,
    TECH_LEAD: agents.techLead,
    BACKEND: agents.backend,
    FRONTEND: agents.frontend,
    TESTER: agents.tester,
  };

  const runStageToApproved = async (
    stage: Stage,
    feedback?: ReviewFeedback,
    forceRun = false,
  ): Promise<StageResult> => {
    let currentFeedback = feedback;
    let shouldRun = forceRun;

    while (true) {
      const saved = results[stage];
      if (!shouldRun && saved) return reuseStage(stage, saved);

      await invalidateFrom(stage);
      const previousArtifacts: Record<string, unknown> = {
        ...results,
        ...extraArtifacts,
      };
      if (currentFeedback) previousArtifacts.reviewFeedback = currentFeedback;

      const input =
        stage === "PM" && !currentFeedback
          ? {
              request: project.request,
              repositoryContext: project.repositoryContext,
              constraints: project.constraints ?? [],
            }
          : { project, previousArtifacts };
      const result = await runStage(stage, agentsByStage[stage], input);

      if (result.status === "approved") {
        await persist(stage, result);
        return result;
      }

      const requests = reviewRequestsFor(stage, result).sort(
        (left, right) => stageIndex(left.role) - stageIndex(right.role),
      );
      const responses: Partial<Record<Stage, StageResult>> = {};

      for (const request of requests) {
        console.error(`[ROUTER] ${stage} -> ${request.role}: ${request.reason}`);
        responses[request.role] = await runStageToApproved(
          request.role,
          {
            requestedBy: stage,
            requests: [request],
            sourceResult: result,
            responses: {},
            previousResult: results[stage],
          },
          true,
        );

        for (const intermediate of deliveryStages.slice(
          stageIndex(request.role) + 1,
          stageIndex(stage),
        )) {
          responses[intermediate] = await runStageToApproved(intermediate);
        }
      }

      currentFeedback = {
        requestedBy: stage,
        requests,
        sourceResult: result,
        responses,
        previousResult: results[stage],
      };
      shouldRun = true;
    }
  };

  const runFinalTechLeadReview = async (): Promise<StageResult> => {
    let feedback: ReviewFeedback | undefined;

    while (true) {
      const previousArtifacts: Record<string, unknown> = {
        ...results,
        ...extraArtifacts,
        finalReviewRequired: true,
      };
      if (feedback) previousArtifacts.reviewFeedback = feedback;

      const result = await runStage(
        "TECH_LEAD",
        agents.techLead,
        { project, previousArtifacts },
        { finalReview: true, artifactFile: "tech_lead_review.json" },
      );
      if (result.status === "approved") {
        extraArtifacts.finalTechLeadReview = result;
        return result;
      }

      const requests = finalCodeReviewRequests(result).sort(
        (left, right) => stageIndex(left.role) - stageIndex(right.role),
      );
      const responses: Partial<Record<Stage, StageResult>> = {};
      for (const request of requests) {
        responses[request.role] = await runStageToApproved(
          request.role,
          {
            requestedBy: "TECH_LEAD",
            requests: [request],
            sourceResult: result,
            responses: {},
          },
          true,
        );
        if (request.role === "BACKEND") {
          await runStageToApproved("FRONTEND", undefined, true);
          await runStageToApproved("TESTER", undefined, true);
        } else if (request.role === "FRONTEND") {
          await runStageToApproved("TESTER", undefined, true);
        }
      }

      feedback = {
        requestedBy: "TECH_LEAD",
        requests,
        sourceResult: result,
        responses,
      };
    }
  };

  for (const stage of deliveryStages.slice(0, -1)) {
    await runStageToApproved(stage);
  }
  await runStageToApproved("TESTER");
  await runFinalTechLeadReview();

  const finalResults = Object.fromEntries(
    deliveryStages.map((stage) => [stage, results[stage]]),
  ) as Record<Stage, StageResult>;
  await savePipelineCheckpoint(project, checkpointResults, new Date().toISOString());
  return finalResults;
}
