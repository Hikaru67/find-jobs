import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LogStream } from "./pipeline-events.js";

const processTimeoutMs = 15 * 60 * 1000;

function runCodexProcess(
  binary: string,
  args: string[],
  prompt: string,
  stage: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  onLog?: (stream: LogStream, message: string) => void,
): Promise<void> {
  const child = spawn(binary, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // The Codex CLI treats a piped stdin as an additional prompt. Sending the
  // prompt through stdin and closing it avoids leaving the CLI waiting for
  // more input after the initial instructions.
  child.stdin?.end(prompt);

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const message = chunk.toString();
    onLog?.("stdout", message);
    process.stdout.write(`[${stage}] ${message}`);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const message = chunk.toString();
    onLog?.("stderr", message);
    process.stderr.write(`[${stage}] ${message}`);
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let didTimeout = false;

    const timeout = setTimeout(() => {
      didTimeout = true;
      child.kill("SIGTERM");
    }, processTimeoutMs);

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    child.once("error", (error) => {
      settle(() => reject(error));
    });

    child.once("close", (code, signal) => {
      settle(() => {
        if (didTimeout) {
          reject(new Error(`[${stage}] timed out after 15 minutes`));
          return;
        }

        if (code === 0) {
          resolve();
          return;
        }

        reject(
          new Error(
            `[${stage}] codex exited with code ${code ?? "unknown"}${signal ? ` (signal ${signal})` : ""}`,
          ),
        );
      });
    });
  });
}

export async function runCodexAgent(
  prompt: string,
  canWriteWorkspace: boolean,
  stage: string,
  onLog?: (stream: LogStream, message: string) => void,
  cwd = process.cwd(),
): Promise<string> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "delivery-codex-"));
  const outputFile = join(tempDirectory, "final-message.txt");
  const codexBinary = process.env.CODEX_BIN ?? "codex";
  const childEnvironment = { ...process.env };

  // Force ChatGPT/Codex login instead of accidentally using the exhausted API key.
  delete childEnvironment.OPENAI_API_KEY;
  delete childEnvironment.CODEX_API_KEY;

  try {
    await runCodexProcess(
      codexBinary,
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--sandbox",
        canWriteWorkspace ? "workspace-write" : "read-only",
        "--output-last-message",
        outputFile,
      "-C",
        cwd,
      ],
      prompt,
      stage,
      cwd,
      childEnvironment,
      onLog,
    );

    return await readFile(outputFile, "utf8");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
