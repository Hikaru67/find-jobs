const STAGES = ["PM", "BA", "TECH_LEAD", "BACKEND", "FRONTEND", "TESTER"];

const STAGE_META = {
  PM: { label: "Product Manager", short: "PM", tone: "violet" },
  BA: { label: "Business Analyst", short: "BA", tone: "blue" },
  TECH_LEAD: { label: "Tech Lead", short: "TL", tone: "cyan" },
  BACKEND: { label: "Backend Developer", short: "BE", tone: "green" },
  FRONTEND: { label: "Frontend Developer", short: "FE", tone: "orange" },
  TESTER: { label: "Tester / Release", short: "QA", tone: "pink" },
};

const state = {
  run: null,
  runs: [],
  selectedStage: "PM",
  eventSource: null,
};

const elements = {
  runForm: document.querySelector("#runForm"),
  requestInput: document.querySelector("#requestInput"),
  submitError: document.querySelector("#submitError"),
  connectionDot: document.querySelector("#connectionDot"),
  connectionText: document.querySelector("#connectionText"),
  runTitle: document.querySelector("#runTitle"),
  runStatus: document.querySelector("#runStatus"),
  progressValue: document.querySelector("#progressValue"),
  progressBar: document.querySelector("#progressBar"),
  activeStage: document.querySelector("#activeStage"),
  activeMode: document.querySelector("#activeMode"),
  elapsedValue: document.querySelector("#elapsedValue"),
  startedValue: document.querySelector("#startedValue"),
  resultValue: document.querySelector("#resultValue"),
  resultNote: document.querySelector("#resultNote"),
  stageRail: document.querySelector("#stageRail"),
  runHistory: document.querySelector("#runHistory"),
  refreshButton: document.querySelector("#refreshButton"),
  detailTitle: document.querySelector("#detailTitle"),
  detailStatus: document.querySelector("#detailStatus"),
  detailSummary: document.querySelector("#detailSummary"),
  detailMeta: document.querySelector("#detailMeta"),
  detailArtifact: document.querySelector("#detailArtifact"),
  stageLogs: document.querySelector("#stageLogs"),
  openQuestions: document.querySelector("#openQuestions"),
  filesAndTests: document.querySelector("#filesAndTests"),
  gitAction: document.querySelector("#gitAction"),
  gitCurrentBranch: document.querySelector("#gitCurrentBranch"),
  gitTaskBranch: document.querySelector("#gitTaskBranch"),
  gitReleaseBranch: document.querySelector("#gitReleaseBranch"),
  gitEvents: document.querySelector("#gitEvents"),
  taskCount: document.querySelector("#taskCount"),
  taskBoard: document.querySelector("#taskBoard"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDuration(milliseconds) {
  if (milliseconds == null || Number.isNaN(milliseconds)) return "—";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function stageLabel(stage) {
  return STAGE_META[stage]?.label ?? stage;
}

function statusLabel(status) {
  return {
    queued: "QUEUED",
    running: "RUNNING",
    completed: "COMPLETED",
    failed: "FAILED",
    pending: "PENDING",
    approved: "APPROVED",
    changes_requested: "CHANGES",
    blocked: "BLOCKED",
  }[status] ?? String(status ?? "IDLE").toUpperCase();
}

function setConnection(connected) {
  elements.connectionDot.classList.toggle("online", connected);
  elements.connectionText.textContent = connected ? "Đang theo dõi live" : "Mất kết nối";
}

function emptyStages() {
  return Object.fromEntries(
    STAGES.map((stage) => [stage, { status: "pending", logs: [] }]),
  );
}

function getStage(stage) {
  return state.run?.stages?.[stage] ?? { status: "pending", logs: [] };
}

function isFinishedStatus(status) {
  return ["approved", "changes_requested", "blocked", "failed"].includes(status);
}

function completedCount() {
  return STAGES.filter((stage) => isFinishedStatus(getStage(stage).status)).length;
}

function renderOverview() {
  const run = state.run;
  if (!run) {
    elements.runTitle.textContent = "Chưa có lượt chạy";
    elements.runStatus.textContent = "IDLE";
    elements.runStatus.className = "badge neutral";
    elements.progressValue.textContent = "0 / 6";
    elements.progressBar.style.width = "0%";
    elements.activeStage.textContent = "—";
    elements.activeMode.textContent = "Đang chờ run";
    elements.elapsedValue.textContent = "00:00";
    elements.startedValue.textContent = "Chưa bắt đầu";
    elements.resultValue.textContent = "Chưa có";
    elements.resultNote.textContent = "Sẵn sàng nhận yêu cầu";
    return;
  }

  const done = completedCount();
  const active = STAGES.find((stage) => getStage(stage).status === "running");
  const terminal = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const started = run.startedAt ? new Date(run.startedAt).getTime() : null;

  elements.runTitle.textContent = run.project.request;
  elements.runStatus.textContent = statusLabel(run.status);
  elements.runStatus.className = `badge ${run.status}`;
  elements.progressValue.textContent = `${done} / 6`;
  elements.progressBar.style.width = `${Math.round((done / 6) * 100)}%`;
  elements.activeStage.textContent = active ? STAGE_META[active].short : run.status === "completed" ? "Done" : "—";
  elements.activeMode.textContent = active
    ? getStage(active).mode ?? "Đang xử lý"
    : run.status === "failed"
      ? "Cần kiểm tra lỗi"
      : "Không có stage đang chạy";
  elements.elapsedValue.textContent = started ? formatDuration(terminal - started) : "00:00";
  elements.startedValue.textContent = started ? `Bắt đầu ${formatDate(run.startedAt)}` : "Đang khởi tạo";
  elements.resultValue.textContent = run.status === "completed" ? "Release gate" : run.status === "failed" ? "Cần xử lý" : `${done}/6 stage`;
  elements.resultNote.textContent = run.error ? run.error : run.status === "completed" ? "Tất cả stage đã approve" : "Pipeline đang cập nhật";
}

function renderStageRail() {
  const html = STAGES.map((stage, index) => {
    const item = getStage(stage);
    const meta = STAGE_META[stage];
    const selected = state.selectedStage === stage ? "selected" : "";
    const status = item.status ?? "pending";
    const icon = status === "running" ? "◌" : status === "approved" ? "✓" : status === "failed" ? "!" : status === "blocked" ? "×" : status === "changes_requested" ? "↺" : "○";
    return `
      <button class="stage-card ${selected} ${status}" data-stage="${stage}">
        <span class="stage-index">0${index + 1}</span>
        <span class="stage-icon tone-${meta.tone}">${icon}</span>
        <span class="stage-copy">
          <strong>${meta.short} <span>${meta.label}</span></strong>
          <small>${item.phase === "final_review" ? "FINAL REVIEW" : item.phase === "code_review" ? "CODE REVIEW" : item.reused ? "RESTORED" : statusLabel(status)}${item.attempt > 1 && item.phase === "delivery" ? ` · REVIEW ${item.attempt - 1}` : ""}${item.durationMs ? ` · ${formatDuration(item.durationMs)}` : ""}</small>
        </span>
        <span class="stage-arrow">→</span>
      </button>
    `;
  }).join("");

  elements.stageRail.innerHTML = html;
  elements.stageRail.querySelectorAll("[data-stage]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedStage = button.dataset.stage;
      renderAll();
    });
  });
}

function renderList(element, values, fallback) {
  element.innerHTML = values?.length
    ? values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")
    : `<li>${escapeHtml(fallback)}</li>`;
}

function renderDetails() {
  const stage = state.selectedStage;
  const item = getStage(stage);
  const meta = STAGE_META[stage];
  const result = item.result;

  elements.detailTitle.textContent = meta.label;
  elements.detailStatus.textContent = statusLabel(item.status);
  elements.detailStatus.className = `badge ${item.status}`;
  elements.detailSummary.textContent = result?.summary ?? item.error ?? "Stage chưa có kết quả.";
  elements.detailMeta.innerHTML = [
    `<span>${meta.short}</span>`,
    `<span>${item.phase === "final_review" ? "Final release review trước master" : item.phase === "code_review" ? "Code review trước dev" : item.reused ? "Checkpoint đã khôi phục" : item.attempt > 1 ? `Review lần ${item.attempt - 1}` : "Lần chạy đầu"}</span>`,
    `<span>${item.mode ?? "—"}</span>`,
    `<span>${item.durationMs ? formatDuration(item.durationMs) : "Chưa có thời lượng"}</span>`,
    `<span>${item.startedAt ? formatDate(item.startedAt) : "Chưa bắt đầu"}</span>`,
  ].map((value) => `<span class="meta-chip">${value}</span>`).join("");
  elements.detailArtifact.textContent = result?.artifact ?? item.error ?? "Chưa có artifact.";

  const logText = (item.logs ?? [])
    .map((entry) => `[${entry.stream}] ${entry.message}`)
    .join("");
  elements.stageLogs.textContent = logText || "Chưa có log.";
  elements.stageLogs.scrollTop = elements.stageLogs.scrollHeight;

  renderList(elements.openQuestions, result?.openQuestions, "Không có câu hỏi mở.");
  const files = result?.filesChanged?.map((file) => `FILE  ${file}`) ?? [];
  const tests = result?.tests?.map((test) => `TEST  ${test}`) ?? [];
  renderList(elements.filesAndTests, [...files, ...tests], "Chưa có files hoặc tests.");
}

function renderGit() {
  const git = state.run?.git;
  if (!git) {
    elements.gitAction.textContent = "Chưa khởi tạo";
    elements.gitAction.className = "badge neutral";
    elements.gitCurrentBranch.textContent = "—";
    elements.gitTaskBranch.textContent = "—";
    elements.gitReleaseBranch.textContent = "—";
    elements.gitEvents.textContent = "Chưa có Git event.";
    return;
  }

  elements.gitAction.textContent = (git.lastAction ?? "local git").replaceAll("_", " ").toUpperCase();
  elements.gitAction.className = `badge ${git.lastAction === "release_merged" ? "approved" : "running"}`;
  elements.gitCurrentBranch.textContent = git.currentBranch ?? "—";
  elements.gitTaskBranch.textContent = git.taskBranch ?? "—";
  elements.gitReleaseBranch.textContent = git.releaseBranch ?? "—";
  elements.gitEvents.textContent = (git.events ?? []).map((event) => {
    const branch = event.branch ? ` ${event.branch}` : "";
    const merge = event.fromBranch && event.toBranch
      ? ` (${event.fromBranch} → ${event.toBranch})`
      : "";
    return `[${formatDate(event.at)}] ${event.action}${branch}${merge}`;
  }).join("\n") || "Chưa có Git event.";
}

function renderTasks() {
  const tasks = Object.values(state.run?.tasks ?? {});
  elements.taskCount.textContent = `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
  if (!tasks.length) {
    elements.taskBoard.innerHTML = '<div class="empty-state">Chưa có task được TECH_LEAD phân rã.</div>';
    return;
  }

  elements.taskBoard.innerHTML = tasks.map((item) => {
    const task = item.task ?? {};
    const status = item.status ?? "running";
    const icon = status === "done" ? "✓" : status === "failed" ? "!" : "◌";
    return `
      <article class="task-row ${status}">
        <span class="task-icon">${icon}</span>
        <div class="task-copy">
          <strong>${escapeHtml(task.title ?? task.id ?? "Task")}</strong>
          <small>${escapeHtml(task.id ?? "—")} · ${escapeHtml(task.owner ?? "—")} · ${escapeHtml(status.toUpperCase())}</small>
        </div>
        <code>${escapeHtml(item.branch ?? "—")}</code>
        <span class="task-deps">${task.dependsOn?.length ? `deps: ${escapeHtml(task.dependsOn.join(", "))}` : "parallel-ready"}</span>
      </article>
    `;
  }).join("");
}

function renderHistory() {
  if (!state.runs.length) {
    elements.runHistory.innerHTML = '<div class="empty-state">Chưa có run nào.</div>';
    return;
  }

  elements.runHistory.innerHTML = state.runs.map((run) => `
    <button class="history-item ${state.run?.id === run.id ? "selected" : ""}" data-run-id="${run.id}">
      <span class="history-status ${run.status}"></span>
      <span class="history-copy">
        <strong>${escapeHtml(run.request.slice(0, 72))}${run.request.length > 72 ? "…" : ""}</strong>
        <small>${statusLabel(run.status)} · ${formatDate(run.startedAt || run.finishedAt)}</small>
      </span>
      <span>→</span>
    </button>
  `).join("");

  elements.runHistory.querySelectorAll("[data-run-id]").forEach((button) => {
    button.addEventListener("click", () => loadRun(button.dataset.runId));
  });
}

function renderAll() {
  renderOverview();
  renderStageRail();
  renderDetails();
  renderGit();
  renderTasks();
  renderHistory();
}

function applyEvent(event) {
  if (!state.run || event.runId !== state.run.id) return;
  const run = state.run;

  if (!run.stages) run.stages = emptyStages();
  switch (event.type) {
    case "run_started":
      run.status = "running";
      run.startedAt = event.at;
      break;
    case "stage_started":
      run.stages[event.stage] = {
        ...run.stages[event.stage],
        status: "running",
        reused: false,
        phase: event.phase,
        attempt: event.attempt,
        mode: event.mode,
        startedAt: event.at,
        result: undefined,
        error: undefined,
        durationMs: undefined,
        logs: [],
      };
      break;
    case "stage_log": {
      const stage = run.stages[event.stage];
      stage.logs = [...(stage.logs ?? []), event].slice(-300);
      break;
    }
    case "stage_reused":
      run.stages[event.stage] = {
        ...run.stages[event.stage],
        status: event.result.status,
        reused: true,
        phase: event.phase,
        result: event.result,
        finishedAt: event.at,
        durationMs: 0,
        error: undefined,
        logs: [{ at: event.at, stream: "stderr", message: "Restored from checkpoint; agent was not called again.\n" }],
      };
      break;
    case "review_routed": {
      const stage = run.stages[event.from];
      stage.logs = [
        ...(stage.logs ?? []),
        {
          at: event.at,
          stream: "stderr",
          message: `[router] review sent to ${event.to}: ${event.reason}\nQuestions: ${event.questions.join(" | ")}\n`,
        },
      ].slice(-300);
      break;
    }
    case "stage_completed":
      run.stages[event.stage] = {
        ...run.stages[event.stage],
        status: event.result.status,
        reused: false,
        phase: event.phase,
        attempt: event.attempt,
        finishedAt: event.at,
        durationMs: event.durationMs,
        result: event.result,
        logs: run.stages[event.stage]?.logs ?? [],
      };
      break;
    case "stage_failed":
      run.stages[event.stage] = {
        ...run.stages[event.stage],
        status: run.stages[event.stage]?.result?.status ?? "failed",
        reused: false,
        phase: event.phase,
        attempt: event.attempt,
        finishedAt: event.at,
        durationMs: event.durationMs,
        error: event.error,
        logs: run.stages[event.stage]?.logs ?? [],
      };
      break;
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
        ...(run.git ?? { events: [] }),
        currentBranch: event.toBranch ?? event.branch ?? run.git?.currentBranch,
        taskBranch: event.branch?.startsWith("task/")
          ? event.branch
          : run.git?.taskBranch,
        releaseBranch: event.branch?.startsWith("release/")
          ? event.branch
          : run.git?.releaseBranch,
        lastAction: event.action,
        events: [...(run.git?.events ?? []), event].slice(-100),
      };
      break;
    case "task_started":
      run.tasks = {
        ...(run.tasks ?? {}),
        [event.task.id]: {
          task: event.task,
          branch: event.branch,
          status: "running",
          startedAt: event.at,
        },
      };
      break;
    case "task_completed":
      run.tasks = {
        ...(run.tasks ?? {}),
        [event.task.id]: {
          ...(run.tasks?.[event.task.id] ?? {}),
          task: event.task,
          branch: event.branch,
          status: "done",
          finishedAt: event.at,
        },
      };
      break;
    case "task_failed":
      run.tasks = {
        ...(run.tasks ?? {}),
        [event.task.id]: {
          ...(run.tasks?.[event.task.id] ?? {}),
          task: event.task,
          branch: event.branch,
          status: "failed",
          finishedAt: event.at,
          error: event.error,
        },
      };
      break;
  }
}

async function loadRuns() {
  try {
    const response = await fetch("/api/runs");
    if (!response.ok) throw new Error("Không tải được lịch sử run");
    state.runs = await response.json();
    renderHistory();
    if (!state.run && state.runs[0]) await loadRun(state.runs[0].id);
    setConnection(true);
  } catch (error) {
    setConnection(false);
    if (!state.run) elements.submitError.textContent = error.message;
  }
}

async function loadRun(runId) {
  if (!runId) return;
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    if (!response.ok) throw new Error("Không tìm thấy run");
    state.run = await response.json();
    state.selectedStage = STAGES.find((stage) => state.run.stages[stage].status !== "pending") ?? "PM";
    connectToRun(state.run.id);
    renderAll();
  } catch (error) {
    elements.submitError.textContent = error.message;
  }
}

function connectToRun(runId) {
  state.eventSource?.close();
  const source = new EventSource(`/api/events?runId=${encodeURIComponent(runId)}`);
  state.eventSource = source;
  source.addEventListener("snapshot", (message) => {
    state.run = JSON.parse(message.data);
    renderAll();
    setConnection(true);
  });
  source.addEventListener("pipeline", (message) => {
    applyEvent(JSON.parse(message.data));
    renderAll();
    loadRuns();
    setConnection(true);
  });
  source.onerror = () => {
    setConnection(false);
  };
}

elements.runForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const request = elements.requestInput.value.trim();
  if (request.length < 5) {
    elements.submitError.textContent = "Hãy nhập yêu cầu dài hơn 5 ký tự.";
    return;
  }

  elements.submitError.textContent = "Đang khởi tạo run...";
  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Không thể bắt đầu pipeline");
    elements.submitError.textContent = "";
    await loadRun(result.id);
    await loadRuns();
  } catch (error) {
    elements.submitError.textContent = error.message;
  }
});

elements.refreshButton.addEventListener("click", () => loadRuns());

setInterval(() => {
  renderOverview();
  if (state.run?.status === "running") loadRuns();
}, 1000);

renderAll();
loadRuns();
