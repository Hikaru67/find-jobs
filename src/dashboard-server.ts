import "dotenv/config";

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runCodexDeliveryPipeline,
  type PipelineRunOptions,
} from "./codex-orchestrator.js";
import type {
  PipelineEvent,
  LogStream,
  StagePhase,
} from "./pipeline-events.js";
import type {
  DeliveryTask,
  ProjectInput,
  Stage,
  StageResult,
} from "./contracts.js";

const host = process.env.DASHBOARD_HOST ?? "127.0.0.1";
const port = Number(process.env.DASHBOARD_PORT ?? 3030);
const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const stages: Stage[] = [
  "PM",
  "BA",
  "TECH_LEAD",
  "BACKEND",
  "FRONTEND",
  "TESTER",
];

type RunStatus = "queued" | "running" | "completed" | "failed";
type StageStatus =
  | "pending"
  | "running"
  | "approved"
  | "changes_requested"
  | "blocked"
  | "failed";

type StageLog = {
  at: string;
  stream: LogStream;
  message: string;
};

type StageView = {
  status: StageStatus;
  reused?: boolean;
  phase?: StagePhase;
  attempt?: number;
  mode?: "read-only" | "workspace-write";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  result?: StageResult;
  error?: string;
  logs: StageLog[];
};

type GitView = {
  currentBranch?: string;
  taskBranch?: string;
  releaseBranch?: string;
  lastAction?: string;
  events: Array<Extract<PipelineEvent, { type: "git_event" }>>;
};

type TaskView = {
  task: DeliveryTask;
  branch: string;
  status: "running" | "done" | "failed";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

type RunView = {
  id: string;
  status: RunStatus;
  project: ProjectInput;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  stages: Record<Stage, StageView>;
  git: GitView;
  tasks: Record<string, TaskView>;
};

const runs = new Map<string, RunView>();
const sseClients = new Map<string, Set<ServerResponse>>();

function createStageViews(): Record<Stage, StageView> {
  return Object.fromEntries(
    stages.map((stage) => [stage, { status: "pending", logs: [] }]),
  ) as unknown as Record<Stage, StageView>;
}

function createRun(id: string, project: ProjectInput): RunView {
  return {
    id,
    status: "queued",
    project,
    stages: createStageViews(),
    git: { events: [] },
    tasks: {},
  };
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendSse(
  response: ServerResponse,
  eventName: string,
  payload: unknown,
): void {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function publish(event: PipelineEvent): void {
  const run = runs.get(event.runId);
  if (!run) return;

  switch (event.type) {
    case "run_started":
      run.status = "running";
      run.startedAt = event.at;
      break;
    case "stage_started": {
      const stage = run.stages[event.stage];
      stage.status = "running";
      stage.reused = false;
      stage.phase = event.phase;
      stage.attempt = event.attempt;
      stage.mode = event.mode;
      stage.startedAt = event.at;
      stage.error = undefined;
      stage.result = undefined;
      stage.durationMs = undefined;
      stage.logs = [];
      break;
    }
    case "stage_reused": {
      const stage = run.stages[event.stage];
      stage.status = event.result.status;
      stage.reused = true;
      stage.phase = event.phase;
      stage.result = event.result;
      stage.finishedAt = event.at;
      stage.durationMs = 0;
      stage.error = undefined;
      stage.logs = [
        {
          at: event.at,
          stream: "stderr",
          message: "Restored from checkpoint; agent was not called again.\n",
        },
      ];
      break;
    }
    case "review_routed": {
      const stage = run.stages[event.from];
      stage.logs.push({
        at: event.at,
        stream: "stderr",
        message: `[router] review sent to ${event.to}: ${event.reason}\nQuestions: ${event.questions.join(" | ")}\n`,
      });
      if (stage.logs.length > 300) stage.logs.splice(0, stage.logs.length - 300);
      break;
    }
    case "stage_log": {
      const stage = run.stages[event.stage];
      stage.logs.push({
        at: event.at,
        stream: event.stream,
        message: event.message.slice(-20_000),
      });
      if (stage.logs.length > 300) stage.logs.splice(0, stage.logs.length - 300);
      break;
    }
    case "stage_completed": {
      const stage = run.stages[event.stage];
      stage.status = event.result.status;
      stage.reused = false;
      stage.phase = event.phase;
      stage.attempt = event.attempt;
      stage.finishedAt = event.at;
      stage.durationMs = event.durationMs;
      stage.result = event.result;
      break;
    }
    case "stage_failed": {
      const stage = run.stages[event.stage];
      stage.status = stage.result?.status ?? "failed";
      stage.reused = false;
      stage.phase = event.phase;
      stage.attempt = event.attempt;
      stage.finishedAt = event.at;
      stage.durationMs = event.durationMs;
      stage.error = event.error;
      break;
    }
    case "run_completed":
      run.status = "completed";
      run.finishedAt = event.at;
      break;
    case "run_failed":
      run.status = "failed";
      run.finishedAt = event.at;
      run.error = event.error;
      break;
    case "git_event":
      run.git = {
        ...run.git,
        currentBranch: event.toBranch ?? event.branch ?? run.git.currentBranch,
        taskBranch: event.branch?.startsWith("task/")
          ? event.branch
          : run.git.taskBranch,
        releaseBranch: event.branch?.startsWith("release/")
          ? event.branch
          : run.git.releaseBranch,
        lastAction: event.action,
        events: [...run.git.events, event].slice(-100),
      };
      break;
    case "task_started":
      run.tasks[event.task.id] = {
        task: event.task,
        branch: event.branch,
        status: "running",
        startedAt: event.at,
      };
      break;
    case "task_completed":
      run.tasks[event.task.id] = {
        ...(run.tasks[event.task.id] ?? {
          task: event.task,
          branch: event.branch,
          status: "running" as const,
        }),
        task: event.task,
        branch: event.branch,
        status: "done",
        finishedAt: event.at,
      };
      break;
    case "task_failed":
      run.tasks[event.task.id] = {
        ...(run.tasks[event.task.id] ?? {
          task: event.task,
          branch: event.branch,
          status: "running" as const,
        }),
        task: event.task,
        branch: event.branch,
        status: "failed",
        finishedAt: event.at,
        error: event.error,
      };
      break;
  }

  for (const client of sseClients.get(event.runId) ?? []) {
    if (!client.writableEnded) sendSse(client, "pipeline", event);
  }
}

function activeRun(): RunView | undefined {
  return [...runs.values()]
    .filter((run) => run.status === "queued" || run.status === "running")
    .sort((left, right) => right.id.localeCompare(left.id))[0];
}

function pruneRuns(): void {
  const completed = [...runs.values()]
    .filter((run) => run.status === "completed" || run.status === "failed")
    .sort((left, right) => (left.finishedAt ?? "").localeCompare(right.finishedAt ?? ""));

  while (runs.size > 20 && completed.length > 0) {
    const oldest = completed.shift();
    if (oldest) runs.delete(oldest.id);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) throw new Error("Request body is too large");
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startRun(project: ProjectInput): Promise<RunView> {
  const existing = activeRun();
  if (existing) {
    throw new Error(`A run is already ${existing.status}: ${existing.id}`);
  }

  const run = createRun(randomUUID(), project);
  runs.set(run.id, run);
  pruneRuns();

  const options: PipelineRunOptions = {
    runId: run.id,
    onEvent: publish,
  };

  void runCodexDeliveryPipeline(project, options).catch(() => {
    // run_failed is emitted by the orchestrator; the dashboard keeps the
    // failure visible in the run state instead of throwing in the HTTP handler.
  });

  return run;
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  let decodedPath: string;

  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    sendJson(response, 400, { error: "Invalid URL path" });
    return;
  }

  const filePath = resolve(publicDirectory, `.${decodedPath}`);
  const relativePath = relative(publicDirectory, filePath);
  if (relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-cache",
    });
    response.end(file);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? `${host}:${port}`}`,
  );

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "multi-agent-dashboard" });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/runs") {
    const summaries = [...runs.values()]
      .sort((left, right) => right.id.localeCompare(left.id))
      .map((run) => ({
        id: run.id,
        status: run.status,
        request: run.project.request,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        error: run.error,
      }));
    sendJson(response, 200, summaries);
    return;
  }

  const runMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === "GET" && runMatch) {
    const run = runs.get(runMatch[1]);
    if (!run) {
      sendJson(response, 404, { error: "Run not found" });
      return;
    }
    sendJson(response, 200, run);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/events") {
    const runId = requestUrl.searchParams.get("runId");
    const run = runId ? runs.get(runId) : undefined;
    if (!runId || !run) {
      sendJson(response, 404, { error: "Run not found" });
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    response.write("retry: 2000\n\n");
    sendSse(response, "snapshot", run);

    const clients = sseClients.get(runId) ?? new Set<ServerResponse>();
    clients.add(response);
    sseClients.set(runId, clients);

    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(": heartbeat\n\n");
    }, 15_000);

    request.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(response);
      if (clients.size === 0) sseClients.delete(runId);
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/runs") {
    try {
      const body = await readJsonBody(request);
      const projectRequest =
        typeof body === "object" && body !== null && "request" in body
          ? (body as { request?: unknown }).request
          : undefined;

      if (typeof projectRequest !== "string" || projectRequest.trim().length < 5) {
        sendJson(response, 400, { error: "request must be at least 5 characters" });
        return;
      }

      const run = await startRun({ request: projectRequest.trim() });
      sendJson(response, 202, {
        id: run.id,
        status: run.status,
        message: "Pipeline started",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message.startsWith("A run is already") ? 409 : 400, {
        error: message,
      });
    }
    return;
  }

  if (request.method === "GET") {
    await serveStatic(requestUrl.pathname, response);
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    if (!response.headersSent) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      response.end();
    }
  });
});

server.listen(port, host, () => {
  console.log(`Dashboard running at http://${host}:${port}`);
});
