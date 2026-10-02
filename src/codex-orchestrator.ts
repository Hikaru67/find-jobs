import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

import {
  stageResultSchema,
  type DeliveryTask,
  type ProjectInput,
  type Stage,
  type StageResult,
} from "./contracts.js";
import {
  loadPipelineCheckpoint,
  savePipelineCheckpoint,
} from "./checkpoint.js";
import { runCodexAgent } from "./codex-runner.js";
import type {
  PipelineEvent,
  PipelineEventHandler,
  StagePhase,
} from "./pipeline-events.js";
import {
  deliveryStages,
  finalCodeReviewRequests,
  reviewRequestsFor,
  stageIndex,
  type ReviewFeedback,
} from "./review-router.js";
import {
  LocalGitWorkflow,
  projectTaskId,
  type LocalTaskWorktree,
  type ReleaseKind,
} from "./git-workflow.js";
import { runTaskPlan } from "./task-scheduler.js";
import { outputContract, roleInstructions } from "./role-prompts.js";

const artifactsDirectory = new URL("../artifacts/", import.meta.url);

export type PipelineRunOptions = {
  runId?: string;
  onEvent?: PipelineEventHandler;
};

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function taskArtifactSegment(taskId: string): string {
  return taskId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || "task";
}

function buildFallbackTasks(
  deliveryId: string,
  releaseKind: ReleaseKind,
  releaseId: string,
): DeliveryTask[] {
  const backendId = `${deliveryId}-backend`;
  return [
    {
      id: backendId,
      phase: `${releaseKind}-${releaseId}`,
      sprint: releaseId,
      title: "Implement the backend scope from the approved technical design",
      owner: "BACKEND",
      dependsOn: [],
      acceptanceCriteria: ["Backend contract and automated checks are implemented."],
      files: [],
      status: "planned",
    },
    {
      id: `${deliveryId}-frontend`,
      phase: `${releaseKind}-${releaseId}`,
      sprint: releaseId,
      title: "Implement the frontend scope from the approved technical design",
      owner: "FRONTEND",
      dependsOn: [],
      acceptanceCriteria: ["Frontend states and automated checks are implemented."],
      files: [],
      status: "planned",
    },
  ];
}

function deliveryTasks(
  tasks: DeliveryTask[],
  deliveryId: string,
  releaseKind: ReleaseKind,
  releaseId: string,
): DeliveryTask[] {
  const planned = tasks.filter((task) => task.owner === "BACKEND" || task.owner === "FRONTEND");
  return planned.length > 0
    ? planned.map((task) => ({ ...task, status: "planned" as const }))
    : buildFallbackTasks(deliveryId, releaseKind, releaseId);
}

function emit(handler: PipelineEventHandler | undefined, event: PipelineEvent): void {
  try {
    handler?.(event);
  } catch (error) {
    console.error(
      "Pipeline event handler failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

function parseJsonResponse(stage: Stage, response: string): StageResult {
  const candidates = [
    response.trim(),
    response.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? "",
  ];

  const objectStart = response.indexOf("{");
  const objectEnd = response.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(response.slice(objectStart, objectEnd + 1));
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return stageResultSchema.parse(JSON.parse(candidate));
    } catch {
      // Try the next extraction strategy before reporting a malformed response.
    }
  }

  throw new Error(
    `${stage} returned an invalid JSON result. Raw response:\n${response.slice(0, 4000)}`,
  );
}

async function saveArtifact(
  stage: Stage,
  result: StageResult,
  artifactFile = `${stage.toLowerCase()}.json`,
): Promise<void> {
  await mkdir(artifactsDirectory, { recursive: true });
  const artifactUrl = new URL(artifactFile, artifactsDirectory);
  await mkdir(new URL(".", artifactUrl), { recursive: true });
  await writeFile(
    artifactUrl,
    `${serialize(result)}\n`,
    "utf8",
  );
}

async function runStage(
  stage: Stage,
  project: ProjectInput,
  previousArtifacts: Record<string, unknown>,
  runId: string,
  onEvent?: PipelineEventHandler,
  attempt = 1,
  options: {
    phase?: StagePhase;
    artifactFile?: string;
    cwd?: string;
    task?: DeliveryTask;
    isolatedTask?: boolean;
  } = {},
): Promise<StageResult> {
  const phase = options.phase ?? "delivery";
  const phaseInstructions = phase === "code_review"
    ? `
This is a mandatory TECH_LEAD code review before the current task branch is merged
into dev. Inspect the actual repository changes in read-only mode. Verify the
approved requirements, technical contract, security, error handling, observability,
and tests. Do not modify files. If code changes are required, set changes_requested
and put BACKEND and/or FRONTEND in reviewRequests with precise fix questions. Set
approved only when the task branch is ready to merge into dev.
`
    : phase === "final_review"
      ? `
This is the mandatory final TECH_LEAD release review after Backend, Frontend, and
Tester work. Inspect the actual repository changes in read-only mode. Verify that
the code matches the approved requirements and technical contract, that Backend and
Frontend boundaries are respected, that security, error handling, observability,
and tests are acceptable, and that the release is safe to merge into master. Do not
modify files. If code changes are required, set changes_requested and put BACKEND
and/or FRONTEND in reviewRequests with precise fix questions. Set approved only
when the current implementation is ready for release.
`
      : "";
  const prompt = `
You are working as the ${stage} stage in a software delivery pipeline.
The repository root is the current working directory.

${roleInstructions[stage]}
${phaseInstructions}
${options.task ? `
Assigned delivery task:
${serialize(options.task)}
Work only within this task's ownership and acceptance criteria. This agent is
running in ${options.isolatedTask === false ? "the integrated dev checkout" : "the task's isolated Git worktree"}. Do not modify unrelated tasks.
` : ""}
${outputContract}

Project input:
${serialize(project)}

Previous stage artifacts:
${serialize(previousArtifacts)}
  `;

  const canWriteWorkspace = stage === "BACKEND" || stage === "FRONTEND";
  const taskId = options.task?.id;
  const startedAt = Date.now();
  const mode = canWriteWorkspace ? "workspace-write" : "read-only";
  console.error(
    `[${stage}] starting (${mode})`,
  );
  emit(onEvent, {
    type: "stage_started",
    runId,
    at: new Date().toISOString(),
    stage,
    ...(taskId ? { taskId } : {}),
    mode,
    attempt,
    phase,
  });

  try {
    const response = await runCodexAgent(
      prompt,
      canWriteWorkspace,
      stage,
      (stream, message) =>
        emit(onEvent, {
          type: "stage_log",
          runId,
          at: new Date().toISOString(),
          stage,
          ...(taskId ? { taskId } : {}),
          stream,
          message,
          phase,
        }),
      options.cwd,
    );
    const parsed = parseJsonResponse(stage, response);

    await saveArtifact(stage, parsed, options.artifactFile);

    const durationMs = Date.now() - startedAt;
    emit(onEvent, {
      type: "stage_completed",
      runId,
      at: new Date().toISOString(),
      stage,
      ...(taskId ? { taskId } : {}),
      durationMs,
      attempt,
      result: parsed,
      phase,
    });

    console.error(`[${stage}] completed in ${durationMs}ms`);
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startedAt;
    console.error(`[${stage}] failed after ${durationMs}ms: ${message}`);
    emit(onEvent, {
      type: "stage_failed",
      runId,
      at: new Date().toISOString(),
      stage,
      ...(taskId ? { taskId } : {}),
      durationMs,
      attempt,
      error: message,
      phase,
    });
    throw error;
  }
}

function reuseStage(
  stage: Stage,
  result: StageResult,
  runId: string,
  onEvent?: PipelineEventHandler,
): StageResult {
  console.error(`[${stage}] reusing approved checkpoint`);
  emit(onEvent, {
    type: "stage_reused",
    runId,
    at: new Date().toISOString(),
    stage,
    result,
    phase: "delivery",
  });
  return result;
}

export async function runCodexDeliveryPipeline(
  project: ProjectInput,
  options: PipelineRunOptions = {},
): Promise<Record<Stage, StageResult>> {
  const runId = options.runId ?? randomUUID();
  const { onEvent } = options;

  emit(onEvent, {
    type: "run_started",
    runId,
    at: new Date().toISOString(),
    project,
  });

  try {
    const git = new LocalGitWorkflow({ runId, onEvent });
    await git.initialize();

    const checkpointResults = await loadPipelineCheckpoint(project);
    const results: Partial<Record<Stage, StageResult>> = checkpointResults;
    const attempts: Partial<Record<Stage, number>> = {};
    const extraArtifacts: Record<string, unknown> = {};
    const taskId = projectTaskId(project.request);
    const releaseKind: ReleaseKind =
      process.env.RELEASE_KIND === "sprint" ? "sprint" : "phase";
    const releaseId = process.env.RELEASE_ID?.trim() || taskId;
    let bugSequence = 0;

    extraArtifacts.gitWorkflow = await git.snapshot();

    const saveGitArtifact = async (): Promise<void> => {
      const snapshot = await git.snapshot();
      extraArtifacts.gitWorkflow = snapshot;
      await mkdir(artifactsDirectory, { recursive: true });
      await writeFile(
        new URL("git-workflow.json", artifactsDirectory),
        `${serialize(snapshot)}\n`,
        "utf8",
      );
    };

    const persist = async (stage: Stage, result: StageResult) => {
      results[stage] = result;
      checkpointResults[stage] = result;
      await savePipelineCheckpoint(project, checkpointResults);
    };

    const invalidateFrom = async (stage: Stage): Promise<void> => {
      const firstInvalidIndex = stageIndex(stage);
      for (const downstream of deliveryStages.slice(firstInvalidIndex)) {
        delete results[downstream];
        delete checkpointResults[downstream];
      }
      await savePipelineCheckpoint(project, checkpointResults);
    };

    const codeOwners = new Set<Stage>(["BACKEND", "FRONTEND"]);
    type TechLeadReviewOptions = {
      phase: "code_review" | "final_review";
      artifactFile: string;
      rerunTester: boolean;
    };
    let runTechLeadReview: (
      reviewOptions: TechLeadReviewOptions,
    ) => Promise<StageResult>;
    let runCodeOwnerFix: (
      request: StageResult["reviewRequests"][number],
      sourceResult: StageResult,
      label: string,
    ) => Promise<StageResult>;

    const runStageToApproved = async (
      stage: Stage,
      feedback?: ReviewFeedback,
      forceRun = false,
    ): Promise<StageResult> => {
      let currentFeedback = feedback;
      let shouldRun = forceRun;

      while (true) {
        const saved = results[stage];
        if (!shouldRun && saved) {
          return reuseStage(stage, saved, runId, onEvent);
        }

        await invalidateFrom(stage);
        const attempt = (attempts[stage] ?? 0) + 1;
        attempts[stage] = attempt;
        const previousArtifacts: Record<string, unknown> = {
          ...results,
          ...extraArtifacts,
        };

        if (currentFeedback) {
          previousArtifacts.reviewFeedback = {
            requestedBy: currentFeedback.requestedBy,
            requests: currentFeedback.requests,
            sourceResult: currentFeedback.sourceResult,
            responses: currentFeedback.responses,
            previousResult: currentFeedback.previousResult,
          };
        }

        const result = await runStage(
          stage,
          project,
          previousArtifacts,
          runId,
          onEvent,
          attempt,
        );

        if (result.status === "approved") {
          await persist(stage, result);
          return result;
        }

        const requests = reviewRequestsFor(stage, result).sort(
          (left, right) => stageIndex(left.role) - stageIndex(right.role),
        );
        const responses: Partial<Record<Stage, StageResult>> = {};

        for (const request of requests) {
          console.error(
            `[ROUTER] ${stage} -> ${request.role}: ${request.reason}`,
          );
          emit(onEvent, {
            type: "review_routed",
            runId,
            at: new Date().toISOString(),
            from: stage,
            to: request.role,
            reason: request.reason,
            questions: request.questions,
          });

          const reviewFeedback: ReviewFeedback = {
            requestedBy: stage,
            requests: [request],
            sourceResult: result,
            responses: {},
            previousResult: results[stage],
          };

          if (stage === "TESTER" && codeOwners.has(request.role)) {
            responses[request.role] = await runCodeOwnerFix(
              request,
              result,
              `tester-${stage.toLowerCase()}`,
            );
          } else {
            responses[request.role] = await runStageToApproved(
              request.role,
              reviewFeedback,
              true,
            );
          }

          const targetIndex = stageIndex(request.role);
          const requesterIndex = stageIndex(stage);
          for (const intermediate of deliveryStages.slice(
            targetIndex + 1,
            requesterIndex,
          )) {
            // A tester defect is already fixed on a dedicated bug branch and
            // merged back into dev. Re-running another code owner here would
            // write directly to dev; the tester loop below is the correct
            // dependent step.
            if (stage === "TESTER" && codeOwners.has(intermediate)) continue;
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

    runTechLeadReview = async ({
      phase,
      artifactFile,
      rerunTester,
    }: TechLeadReviewOptions): Promise<StageResult> => {
      let feedback: ReviewFeedback | undefined;
      let attempt = 1;

      while (true) {
        const previousArtifacts: Record<string, unknown> = {
          ...results,
          ...extraArtifacts,
          codeReviewRequired: phase === "code_review",
          finalReviewRequired: phase === "final_review",
        };
        if (feedback) previousArtifacts.reviewFeedback = feedback;

        const result = await runStage(
          "TECH_LEAD",
          project,
          previousArtifacts,
          runId,
          onEvent,
          attempt,
          {
            phase,
            artifactFile,
          },
        );

        if (result.status === "approved") {
          extraArtifacts[phase === "code_review" ? "taskTechLeadReview" : "finalTechLeadReview"] = result;
          return result;
        }

        const requests = finalCodeReviewRequests(result).sort(
          (left, right) => stageIndex(left.role) - stageIndex(right.role),
        );
        const responses: Partial<Record<Stage, StageResult>> = {};

        for (const request of requests) {
          console.error(
            `[ROUTER] TECH_LEAD final review -> ${request.role}: ${request.reason}`,
          );
          emit(onEvent, {
            type: "review_routed",
            runId,
            at: new Date().toISOString(),
            from: "TECH_LEAD",
            to: request.role,
            reason: request.reason,
            questions: request.questions,
            phase,
          });

          if (phase === "final_review" && codeOwners.has(request.role)) {
            responses[request.role] = await runCodeOwnerFix(
              request,
              result,
              "release-review",
            );
            if (rerunTester) {
              await git.checkoutDev();
              await runStageToApproved("TESTER", undefined, true);
            }
          } else {
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

            if (rerunTester && request.role === "BACKEND") {
              await runStageToApproved("FRONTEND", undefined, true);
              await runStageToApproved("TESTER", undefined, true);
            } else if (rerunTester && request.role === "FRONTEND") {
              await runStageToApproved("TESTER", undefined, true);
            }
          }
        }

        feedback = {
          requestedBy: "TECH_LEAD",
          requests,
          sourceResult: result,
          responses,
        };
        attempt += 1;
      }
    };

    runCodeOwnerFix = async (request, sourceResult, label): Promise<StageResult> => {
      bugSequence += 1;
      const bugBranch = await git.beginBugFix(taskId, request.role, bugSequence);
      console.error(`[GIT] ${request.role} fix branch ${bugBranch}`);

      const fixed = await runStageToApproved(
        request.role,
        {
          requestedBy: label === "release-review" ? "TECH_LEAD" : "TESTER",
          requests: [request],
          sourceResult,
          responses: {},
        },
        true,
      );

      await runTechLeadReview({
        phase: "code_review",
        artifactFile: `tech_lead_${label}_${bugSequence}.json`,
        rerunTester: false,
      });
      await git.commitTask(`fix: resolve ${request.role} review for ${taskId}`);
      await git.mergeTaskIntoDev(bugBranch);
      await git.checkoutDev();
      await saveGitArtifact();
      return fixed;
    };

    const runIsolatedTask = async (
      task: DeliveryTask,
      worktree: LocalTaskWorktree,
    ): Promise<{ ownerResult: StageResult; reviewResult: StageResult }> => {
      const localResults: Partial<Record<Stage, StageResult>> = {};
      const localAttempts: Partial<Record<Stage, number>> = {};
      const artifactSegment = taskArtifactSegment(task.id);

      const runTaskRole = async (
        stage: Stage,
        feedback?: ReviewFeedback,
        forceRun = false,
        phase: StagePhase = "delivery",
      ): Promise<StageResult> => {
        let currentFeedback = feedback;
        let shouldRun = forceRun;

        while (true) {
          const saved = localResults[stage];
          if (!shouldRun && saved) return saved;

          const attempt = (localAttempts[stage] ?? 0) + 1;
          localAttempts[stage] = attempt;
          const previousArtifacts: Record<string, unknown> = {
            ...results,
            ...extraArtifacts,
            taskResults: localResults,
          };
          if (currentFeedback) previousArtifacts.reviewFeedback = currentFeedback;

          const result = await runStage(
            stage,
            project,
            previousArtifacts,
            runId,
            onEvent,
            attempt,
            {
              phase,
              cwd: worktree.path,
              task,
              artifactFile: `tasks/${artifactSegment}/${stage.toLowerCase()}-${phase}-${attempt}.json`,
            },
          );

          if (result.status === "approved") {
            localResults[stage] = result;
            return result;
          }

          const requests = reviewRequestsFor(stage, result).sort(
            (left, right) => stageIndex(left.role) - stageIndex(right.role),
          );
          const responses: Partial<Record<Stage, StageResult>> = {};

          for (const request of requests) {
            emit(onEvent, {
              type: "review_routed",
              runId,
              at: new Date().toISOString(),
              from: stage,
              to: request.role,
              taskId: task.id,
              reason: request.reason,
              questions: request.questions,
              phase,
            });

            responses[request.role] = await runTaskRole(
              request.role,
              {
                requestedBy: stage,
                requests: [request],
                sourceResult: result,
                responses: {},
                previousResult: localResults[stage],
              },
              true,
              request.role === "TECH_LEAD" ? "code_review" : "delivery",
            );
          }

          currentFeedback = {
            requestedBy: stage,
            requests,
            sourceResult: result,
            responses,
            previousResult: localResults[stage],
          };
          shouldRun = true;
        }
      };

      const ownerResult = await runTaskRole(task.owner);
      const reviewResult = await runTaskRole("TECH_LEAD", undefined, true, "code_review");
      await worktree.workflow.commitTask(`feat: complete task ${task.id}`);
      return { ownerResult, reviewResult };
    };

    const saveTaskPlan = async (
      tasks: DeliveryTask[],
      branches: Record<string, string>,
      status: string,
    ): Promise<void> => {
      const snapshot = {
        status,
        releaseKind,
        releaseId,
        updatedAt: new Date().toISOString(),
        tasks: tasks.map((task) => ({
          ...task,
          status,
          branch: branches[task.id],
        })),
      };
      extraArtifacts.taskPlan = snapshot;
      await mkdir(artifactsDirectory, { recursive: true });
      await writeFile(
        new URL("task-plan.json", artifactsDirectory),
        `${serialize(snapshot)}\n`,
        "utf8",
      );
    };

    // Product, requirements, and technical design are prepared on dev.
    for (const stage of deliveryStages.slice(0, 3)) {
      await runStageToApproved(stage);
    }

    const tasks = deliveryTasks(
      results.TECH_LEAD?.tasks ?? [],
      taskId,
      releaseKind,
      releaseId,
    );
    const taskBranches: Record<string, string> = {};
    await saveTaskPlan(tasks, taskBranches, "planned");

    const maxParallelAgents = Number(process.env.MAX_PARALLEL_AGENTS ?? "4");
    const taskExecutions = await runTaskPlan({
      tasks,
      maxParallel: Number.isFinite(maxParallelAgents) ? maxParallelAgents : 4,
      execute: async (task) => {
        const worktree = await git.createTaskWorktree(`${taskId}-${task.id}`);
        taskBranches[task.id] = worktree.branch;
        emit(onEvent, {
          type: "task_started",
          runId,
          at: new Date().toISOString(),
          task,
          branch: worktree.branch,
        });

        try {
          const taskResult = await runIsolatedTask(task, worktree);
          return { ...taskResult, worktree };
        } catch (error) {
          emit(onEvent, {
            type: "task_failed",
            runId,
            at: new Date().toISOString(),
            task,
            branch: worktree.branch,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      onBatchComplete: async (batch) => {
        for (const item of batch) {
          await git.mergeTaskIntoDev(item.value.worktree.branch);
          await git.removeTaskWorktree(item.value.worktree.path);
          emit(onEvent, {
            type: "task_completed",
            runId,
            at: new Date().toISOString(),
            task: item.task,
            branch: item.value.worktree.branch,
          });
        }
        await git.checkoutDev();
        await saveTaskPlan(tasks, taskBranches, "merged-to-dev");
        await saveGitArtifact();
      },
    });

    const aggregateOwnerResult = (owner: "BACKEND" | "FRONTEND"): StageResult | undefined => {
      const owned = taskExecutions.filter((item) => item.task.owner === owner);
      if (owned.length === 0) return undefined;
      return {
        stage: owner,
        status: "approved",
        summary: `${owned.length} ${owner} task(s) completed and reviewed on isolated branches.`,
        artifact: owned
          .map((item) => `- ${item.task.id}: ${item.value.ownerResult.summary}`)
          .join("\n"),
        assumptions: [],
        openQuestions: [],
        filesChanged: [...new Set(owned.flatMap((item) => item.value.ownerResult.filesChanged))],
        tests: [...new Set(owned.flatMap((item) => item.value.ownerResult.tests))],
        reviewRequests: [],
        tasks,
      };
    };

    for (const owner of ["BACKEND", "FRONTEND"] as const) {
      const aggregate = aggregateOwnerResult(owner);
      if (aggregate) await persist(owner, aggregate);
    }

    await saveTaskPlan(tasks, taskBranches, "ready-for-integration-test");

    // Run one read-only Tester per completed task in parallel against the
    // integrated dev branch. A final TESTER stage below remains the release gate
    // and owns the bug-branch loop for defects found by any parallel tester.
    const taskTestSettled = await Promise.allSettled(
      taskExecutions.map(async (item) => {
        const result = await runStage(
          "TESTER",
          project,
          {
            ...results,
            ...extraArtifacts,
            taskPlan: tasks,
            taskUnderTest: item.task,
          },
          runId,
          onEvent,
          1,
          {
            cwd: process.cwd(),
            task: item.task,
            isolatedTask: false,
            artifactFile: `tasks/${taskArtifactSegment(item.task.id)}/tester.json`,
          },
        );
        return { task: item.task, result };
      }),
    );
    const failedTaskTest = taskTestSettled.find(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    if (failedTaskTest) {
      throw failedTaskTest.reason instanceof Error
        ? failedTaskTest.reason
        : new Error(String(failedTaskTest.reason));
    }
    extraArtifacts.taskTestResults = taskTestSettled.map(
      (item) => (item as PromiseFulfilledResult<{ task: DeliveryTask; result: StageResult }>).value,
    );

    // Tester runs against the integrated dev branch. Defects automatically get
    // a new bug branch from dev, a DEV owner, a TECH_LEAD review, and a merge
    // back into dev before the tester is retried.
    await runStageToApproved("TESTER", undefined, true);

    // Final release review happens on dev after the test loop has passed.
    await runTechLeadReview({
      phase: "final_review",
      artifactFile: "tech_lead_review.json",
      rerunTester: true,
    });
    await git.checkoutDev();

    const releaseBranch = await git.beginRelease(releaseKind, releaseId);
    await git.mergeReleaseIntoMaster(releaseBranch);
    await saveGitArtifact();

    const finalResults = Object.fromEntries(
      deliveryStages.map((stage) => [stage, results[stage]]),
    ) as Record<Stage, StageResult>;

    await savePipelineCheckpoint(
      project,
      checkpointResults,
      new Date().toISOString(),
    );

    emit(onEvent, {
      type: "run_completed",
      runId,
      at: new Date().toISOString(),
      results: finalResults,
    });
    return finalResults;
  } catch (error) {
    emit(onEvent, {
      type: "run_failed",
      runId,
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
