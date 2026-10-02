import "dotenv/config";

const request = process.argv.slice(2).join(" ").trim();

if (!request) {
  console.error(
    'Usage: npm run dev -- "Build a job application tracker with login and status workflow"',
  );
  process.exitCode = 1;
} else {
  try {
    const runtime = process.env.AGENT_RUNTIME ?? "codex";
    const result = runtime === "api"
      ? await (await import("./orchestrator.js")).runDeliveryPipeline({ request })
      : await (await import("./codex-orchestrator.js")).runCodexDeliveryPipeline({ request });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
