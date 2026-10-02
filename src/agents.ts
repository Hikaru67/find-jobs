import { Agent } from "@openai/agents";

import { stageResultSchema, type Stage } from "./contracts.js";
import { outputContract, roleInstructions } from "./role-prompts.js";

const configuredModel = process.env.OPENAI_MODEL;
const modelOptions = configuredModel ? { model: configuredModel } : {};

export type StageAgent = Agent<unknown, typeof stageResultSchema>;

function createAgent(stage: Stage, name: string): StageAgent {
  return new Agent({
    name,
    instructions: `${roleInstructions[stage]}\n${outputContract}`,
    outputType: stageResultSchema,
    ...modelOptions,
  });
}

export const agents = {
  pm: createAgent("PM", "PM Agent"),
  ba: createAgent("BA", "BA Agent"),
  techLead: createAgent("TECH_LEAD", "Tech Lead Agent"),
  backend: createAgent("BACKEND", "Backend Developer Agent"),
  frontend: createAgent("FRONTEND", "Frontend Developer Agent"),
  tester: createAgent("TESTER", "Tester Agent"),
};
