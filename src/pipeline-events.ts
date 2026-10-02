import type {
  DeliveryTask,
  ProjectInput,
  Stage,
  StageResult,
} from "./contracts.js";

export type LogStream = "stdout" | "stderr";
export type StagePhase = "delivery" | "code_review" | "final_review";

export type GitAction =
  | "repository_initialized"
  | "branch_created"
  | "branch_reused"
  | "branch_checked_out"
  | "commit_created"
  | "merge_completed"
  | "release_ready"
  | "release_merged";

export type PipelineEvent =
  | {
      type: "run_started";
      runId: string;
      at: string;
      project: ProjectInput;
    }
  | {
      type: "stage_started";
      runId: string;
      at: string;
      stage: Stage;
      taskId?: string;
      mode: "read-only" | "workspace-write";
      attempt: number;
      phase: StagePhase;
    }
  | {
      type: "stage_log";
      runId: string;
      at: string;
      stage: Stage;
      taskId?: string;
      stream: LogStream;
      message: string;
      phase: StagePhase;
    }
  | {
      type: "stage_reused";
      runId: string;
      at: string;
      stage: Stage;
      taskId?: string;
      result: StageResult;
      phase: StagePhase;
    }
  | {
      type: "review_routed";
      runId: string;
      at: string;
      from: Stage;
      to: Stage;
      taskId?: string;
      reason: string;
      questions: string[];
      phase?: StagePhase;
    }
  | {
      type: "stage_completed";
      runId: string;
      at: string;
      stage: Stage;
      taskId?: string;
      durationMs: number;
      attempt: number;
      result: StageResult;
      phase: StagePhase;
    }
  | {
      type: "stage_failed";
      runId: string;
      at: string;
      stage: Stage;
      taskId?: string;
      durationMs: number;
      attempt: number;
      error: string;
      phase: StagePhase;
    }
  | {
      type: "run_completed";
      runId: string;
      at: string;
      results: Record<Stage, StageResult>;
    }
  | {
      type: "run_failed";
      runId: string;
      at: string;
      error: string;
    }
  | {
      type: "task_started";
      runId: string;
      at: string;
      task: DeliveryTask;
      branch: string;
    }
  | {
      type: "task_completed";
      runId: string;
      at: string;
      task: DeliveryTask;
      branch: string;
    }
  | {
      type: "task_failed";
      runId: string;
      at: string;
      task: DeliveryTask;
      branch: string;
      error: string;
    }
  | {
      type: "git_event";
      runId: string;
      at: string;
      action: GitAction;
      branch?: string;
      fromBranch?: string;
      toBranch?: string;
      baseBranch?: string;
      commit?: string;
      message?: string;
      releaseId?: string;
    };

export type PipelineEventHandler = (event: PipelineEvent) => void;
