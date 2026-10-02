import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import {
  stageResultSchema,
  type ProjectInput,
  type Stage,
  type StageResult,
} from "./contracts.js";

const artifactsDirectory = new URL("../artifacts/", import.meta.url);
const checkpointFile = new URL("pipeline-state.json", artifactsDirectory);
const checkpointTempFile = new URL("pipeline-state.json.tmp", artifactsDirectory);
const stages: Stage[] = [
  "PM",
  "BA",
  "TECH_LEAD",
  "BACKEND",
  "FRONTEND",
  "TESTER",
];

type StoredCheckpoint = {
  version: 1;
  projectHash: string;
  updatedAt: string;
  completedAt?: string;
  results: Partial<Record<Stage, StageResult>>;
};

function projectHash(project: ProjectInput): string {
  const canonical = JSON.stringify({
    request: project.request,
    repositoryContext: project.repositoryContext ?? null,
    constraints: project.constraints ?? [],
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function loadPipelineCheckpoint(
  project: ProjectInput,
): Promise<Partial<Record<Stage, StageResult>>> {
  try {
    const raw = JSON.parse(await readFile(checkpointFile, "utf8")) as Partial<StoredCheckpoint>;
    if (
      raw.version !== 1 ||
      raw.projectHash !== projectHash(project) ||
      raw.completedAt ||
      !raw.results
    ) {
      return {};
    }

    const results: Partial<Record<Stage, StageResult>> = {};
    for (const stage of stages) {
      const parsed = stageResultSchema.safeParse(raw.results[stage]);
      if (parsed.success && parsed.data.status === "approved") {
        results[stage] = parsed.data;
      }
    }
    return results;
  } catch {
    return {};
  }
}

export async function savePipelineCheckpoint(
  project: ProjectInput,
  results: Partial<Record<Stage, StageResult>>,
  completedAt?: string,
): Promise<void> {
  await mkdir(artifactsDirectory, { recursive: true });
  const checkpoint: StoredCheckpoint = {
    version: 1,
    projectHash: projectHash(project),
    updatedAt: new Date().toISOString(),
    results,
    ...(completedAt ? { completedAt } : {}),
  };

  await writeFile(checkpointTempFile, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await rename(checkpointTempFile, checkpointFile);
}
