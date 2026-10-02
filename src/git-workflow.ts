import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { PipelineEvent, PipelineEventHandler } from "./pipeline-events.js";

const execFileAsync = promisify(execFile);

type GitResult = {
  stdout: string;
  stderr: string;
};

type GitWorkflowOptions = {
  runId: string;
  onEvent?: PipelineEventHandler;
  cwd?: string;
  gitDir?: string;
};

export type ReleaseKind = "sprint" | "phase";

export type GitWorkflowSnapshot = {
  repositoryInitialized: boolean;
  currentBranch: string;
  masterBranch: "master";
  devBranch: "dev";
  taskBranch?: string;
  releaseBranch?: string;
  taskId?: string;
  releaseId?: string;
  commits: string[];
};

export type LocalTaskWorktree = {
  taskId: string;
  branch: string;
  path: string;
  workflow: LocalGitWorkflow;
};

function branchPart(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/.]+|[-/.]+$/g, "");

  return normalized || "unnamed";
}

export function projectTaskId(request: string): string {
  return `delivery-${createHash("sha256").update(request).digest("hex").slice(0, 12)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LocalGitWorkflow {
  private readonly runId: string;
  private readonly onEvent?: PipelineEventHandler;
  private readonly cwd: string;
  private readonly configuredGitDir?: string;
  private gitDir?: string;
  private taskBranch?: string;
  private releaseBranch?: string;
  private taskId?: string;
  private releaseId?: string;
  private commits: string[] = [];

  constructor(options: GitWorkflowOptions) {
    this.runId = options.runId;
    this.onEvent = options.onEvent;
    this.cwd = options.cwd ?? process.cwd();
    this.configuredGitDir = options.gitDir
      ? resolve(options.gitDir)
      : process.env.LOCAL_GIT_DIR?.trim()
      ? resolve(this.cwd, process.env.LOCAL_GIT_DIR.trim())
      : undefined;
  }

  private emit(
    action: Extract<
      PipelineEvent,
      { type: "git_event" }
    >["action"],
    details: Omit<Extract<PipelineEvent, { type: "git_event" }>, "type" | "runId" | "at" | "action"> = {},
  ): void {
    this.onEvent?.({
      type: "git_event",
      runId: this.runId,
      at: new Date().toISOString(),
      action,
      ...details,
    });
  }

  private async git(args: string[], raw = false): Promise<GitResult> {
    const gitArgs = !raw && this.gitDir
      ? ["--git-dir", this.gitDir, "--work-tree", this.cwd, ...args]
      : args;
    try {
      const result = await execFileAsync("git", gitArgs, {
        cwd: this.cwd,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      return {
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
      };
    } catch (error) {
      const detail = error as Error & { stdout?: string; stderr?: string };
      const output = [detail.stdout, detail.stderr].filter(Boolean).join("\n");
      throw new Error(`git ${gitArgs.join(" ")} failed${output ? `: ${output.trim()}` : `: ${errorMessage(error)}`}`);
    }
  }

  private async tryGit(args: string[]): Promise<GitResult | undefined> {
    try {
      return await this.git(args);
    } catch {
      return undefined;
    }
  }

  private async branchExists(branch: string): Promise<boolean> {
    return Boolean(await this.tryGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]));
  }

  private async currentBranch(): Promise<string> {
    const result = await this.git(["branch", "--show-current"]);
    return result.stdout.trim();
  }

  private async isDirty(): Promise<boolean> {
    const result = await this.git(["status", "--porcelain"]);
    return result.stdout.trim().length > 0;
  }

  private async ensureClean(operation: string): Promise<void> {
    if (await this.isDirty()) {
      throw new Error(
        `Cannot ${operation}: the local worktree has uncommitted changes. ` +
          "Commit or review the changes before switching branches.",
      );
    }
  }

  private async selectGitDirectory(): Promise<void> {
    if (this.configuredGitDir) {
      this.gitDir = this.configuredGitDir;
      return;
    }

    const standardGitDirectory = join(this.cwd, ".git");
    try {
      await access(standardGitDirectory, constants.F_OK);
    } catch {
      // No .git directory exists yet; use the standard Git layout.
      return;
    }

    try {
      await access(standardGitDirectory, constants.W_OK);
    } catch {
      // Some managed workspaces expose .git as read-only. Keep the working
      // files in place and store local-only refs in a separate ignored dir.
      this.gitDir = join(this.cwd, ".delivery-git");
    }
  }

  private async commit(message: string): Promise<string | undefined> {
    if (!(await this.isDirty())) return undefined;

    await this.git(["add", "-A"]);
    await this.git([
      "-c",
      "user.name=Local Agent Delivery",
      "-c",
      "user.email=agent-delivery@localhost",
      "commit",
      "-m",
      message,
    ]);
    const commit = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    this.commits.push(commit);
    this.emit("commit_created", { branch: await this.currentBranch(), commit, message });
    return commit;
  }

  private async switchBranch(branch: string): Promise<void> {
    const current = await this.currentBranch();
    if (current === branch) return;
    await this.ensureClean(`switch to ${branch}`);
    await this.git(["switch", branch]);
    this.emit("branch_checked_out", { branch, fromBranch: current });
  }

  private async createOrReuseBranch(branch: string, baseBranch: string): Promise<void> {
    if (await this.branchExists(branch)) {
      await this.switchBranch(branch);
      this.emit("branch_reused", { branch, baseBranch });
      return;
    }

    await this.ensureClean(`create ${branch}`);
    await this.git(["switch", "-c", branch, baseBranch]);
    this.emit("branch_created", { branch, baseBranch });
  }

  async initialize(): Promise<GitWorkflowSnapshot> {
    await this.selectGitDirectory();
    const repository = await this.tryGit(["rev-parse", "--is-inside-work-tree"]);
    if (!repository) {
      if (this.gitDir) {
        await this.git(["init", "--bare", "--initial-branch=master", this.gitDir], true);
        await this.git(["config", "core.bare", "false"]);
        await this.git(["config", "core.worktree", this.cwd]);
      } else {
        await this.git(["init", "-b", "master"]);
      }
      await this.commit("chore: initialize local delivery repository");
      this.emit("repository_initialized", { branch: "master" });
    } else {
      const head = await this.tryGit(["rev-parse", "--verify", "HEAD"]);
      if (!head) {
        await this.commit("chore: initialize local delivery repository");
        this.emit("repository_initialized", { branch: await this.currentBranch() });
      }
    }

    if (!(await this.branchExists("master"))) {
      const current = await this.currentBranch();
      await this.git(["branch", "master", current]);
      this.emit("branch_created", { branch: "master", baseBranch: current });
    }
    if (!(await this.branchExists("dev"))) {
      await this.git(["branch", "dev", "master"]);
      this.emit("branch_created", { branch: "dev", baseBranch: "master" });
    }

    const current = await this.currentBranch();
    if (current !== "dev" && !(await this.isDirty())) {
      await this.switchBranch("dev");
    }

    return this.snapshot();
  }

  async beginTask(taskId: string): Promise<string> {
    const safeTaskId = branchPart(taskId);
    this.taskId = safeTaskId;
    this.taskBranch = `task/${safeTaskId}`;
    await this.createOrReuseBranch(this.taskBranch, "dev");
    return this.taskBranch;
  }

  async createTaskWorktree(taskId: string): Promise<LocalTaskWorktree> {
    const safeTaskId = branchPart(taskId);
    const branch = `task/${safeTaskId}`;
    const worktreePath = resolve(this.cwd, ".agent-worktrees", safeTaskId);
    await mkdir(resolve(worktreePath, ".."), { recursive: true });

    const worktreeExists = await this.tryGit([
      "worktree",
      "list",
      "--porcelain",
    ]);
    const isRegistered = Boolean(
      worktreeExists?.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length).trim())
        .includes(worktreePath),
    );

    if (!isRegistered) {
      if (await this.branchExists(branch)) {
        await this.git(["worktree", "add", worktreePath, branch]);
      } else {
        await this.git(["worktree", "add", "-b", branch, worktreePath, "dev"]);
      }
      this.emit("branch_created", { branch, baseBranch: "dev" });
    }

    const workflow = new LocalGitWorkflow({
      runId: this.runId,
      onEvent: this.onEvent,
      cwd: worktreePath,
      gitDir: this.gitDir,
    });
    workflow.taskId = safeTaskId;
    workflow.taskBranch = branch;
    return { taskId: safeTaskId, branch, path: worktreePath, workflow };
  }

  async removeTaskWorktree(worktreePath: string): Promise<void> {
    await this.git(["worktree", "remove", worktreePath]);
  }

  async beginBugFix(taskId: string, owner: string, sequence: number): Promise<string> {
    const safeTaskId = branchPart(taskId);
    const safeOwner = branchPart(owner);
    this.taskId = safeTaskId;
    this.taskBranch = `bug/${safeTaskId}/${String(sequence).padStart(2, "0")}-${safeOwner}`;
    await this.switchBranch("dev");
    await this.createOrReuseBranch(this.taskBranch, "dev");
    return this.taskBranch;
  }

  async commitTask(message: string): Promise<string | undefined> {
    if (!this.taskBranch) throw new Error("No task branch has been started");
    const current = await this.currentBranch();
    if (current !== this.taskBranch) {
      throw new Error(`Expected task branch ${this.taskBranch}, found ${current}`);
    }
    return this.commit(message);
  }

  async mergeTaskIntoDev(taskBranch = this.taskBranch): Promise<void> {
    if (!taskBranch) throw new Error("No task branch is available to merge");
    await this.commit("chore: checkpoint local task changes");
    await this.switchBranch("dev");
    await this.git(["merge", "--no-ff", "--no-edit", taskBranch]);
    this.emit("merge_completed", {
      branch: taskBranch,
      fromBranch: taskBranch,
      toBranch: "dev",
    });
  }

  async beginRelease(kind: ReleaseKind, releaseId: string): Promise<string> {
    const safeKind = branchPart(kind);
    const safeReleaseId = branchPart(releaseId);
    this.releaseId = safeReleaseId;
    this.releaseBranch = `release/${safeKind}-${safeReleaseId}`;
    await this.switchBranch("dev");
    await this.createOrReuseBranch(this.releaseBranch, "dev");
    this.emit("release_ready", {
      branch: this.releaseBranch,
      fromBranch: "dev",
      releaseId: safeReleaseId,
    });
    return this.releaseBranch;
  }

  async mergeReleaseIntoMaster(releaseBranch = this.releaseBranch): Promise<void> {
    if (!releaseBranch) throw new Error("No release branch is available to merge");
    await this.ensureClean("merge release into master");
    await this.switchBranch("master");
    await this.git(["merge", "--no-ff", "--no-edit", releaseBranch]);
    this.emit("release_merged", {
      branch: releaseBranch,
      fromBranch: releaseBranch,
      toBranch: "master",
      releaseId: this.releaseId,
    });
    await this.switchBranch("dev");
  }

  async checkoutDev(): Promise<void> {
    await this.switchBranch("dev");
  }

  async snapshot(): Promise<GitWorkflowSnapshot> {
    return {
      repositoryInitialized: true,
      currentBranch: await this.currentBranch(),
      masterBranch: "master",
      devBranch: "dev",
      taskBranch: this.taskBranch,
      releaseBranch: this.releaseBranch,
      taskId: this.taskId,
      releaseId: this.releaseId,
      commits: [...this.commits],
    };
  }
}
