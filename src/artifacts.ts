import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { WorkflowEvent, WorkflowRunResult } from "./types.ts";

export async function createRunArtifacts(cwd: string, runId: string, workflowPath: string): Promise<string> {
  await ensureWorkflowGitignore(cwd);
  const runDir = path.join(cwd, ".codex-workflows", "runs", runId);
  await mkdir(path.join(runDir, "agents"), { recursive: true });
  await copyFile(workflowPath, path.join(runDir, "workflow.js"));
  return runDir;
}

export async function appendEvent(runDir: string, event: WorkflowEvent): Promise<void> {
  await appendFile(path.join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

export async function writeRunStatus(runDir: string, result: WorkflowRunResult): Promise<void> {
  await writeFile(path.join(runDir, "status.json"), JSON.stringify(result, null, 2), "utf8");
  await writeFile(path.join(runDir, "summary.md"), renderSummary(result), "utf8");
}

export async function writeFailedStatus(runDir: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await writeFile(path.join(runDir, "status.json"), JSON.stringify({ ok: false, error: message }, null, 2), "utf8");
  await writeFile(path.join(runDir, "summary.md"), `# Workflow Failed\n\n${message}\n`, "utf8");
}

export async function ensureWorkflowGitignore(cwd: string): Promise<void> {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entries = [".codex-workflows/runs/", ".codex-workflows/worktrees/"];
  let content = "";
  if (existsSync(gitignorePath)) content = await readFile(gitignorePath, "utf8");
  const missing = entries.filter((entry) => !content.split(/\r?\n/).includes(entry));
  if (missing.length === 0) return;
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  await appendFile(gitignorePath, `${prefix}${missing.join("\n")}\n`, "utf8");
}

function renderSummary(result: WorkflowRunResult): string {
  return [
    `# ${result.meta.name}`,
    "",
    result.meta.description,
    "",
    `- Agents: ${result.agentCount}`,
    `- Duration: ${result.durationMs}ms`,
    `- Phases: ${result.phases.length ? result.phases.join(", ") : "none"}`,
    "",
    "## Result",
    "",
    "```json",
    JSON.stringify(result.result, null, 2),
    "```",
    ""
  ].join("\n");
}
