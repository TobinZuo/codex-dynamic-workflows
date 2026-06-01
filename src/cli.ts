#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRunArtifacts, appendEvent, writeFailedStatus, writeRunStatus } from "./artifacts.ts";
import { CodexCliAgentRunner } from "./codex-adapter.ts";
import { createWorkflow } from "./create.ts";
import { runWorkflow } from "./runtime.ts";
import type { WorkflowMode } from "./types.ts";

interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.command === "help" || parsed.flags.help || parsed.flags.h) {
    printHelp();
    return;
  }

  if (parsed.command === "run") {
    await runCommand(parsed);
    return;
  }
  if (parsed.command === "create") {
    await createCommand(parsed);
    return;
  }

  throw new Error(`unknown command: ${parsed.command}`);
}

async function runCommand(parsed: ParsedArgs): Promise<void> {
  const workflowArg = parsed.positional[0];
  if (!workflowArg) throw new Error("run requires <workflow.js>");
  const cwd = path.resolve(stringFlag(parsed, "cwd") ?? process.cwd());
  const workflowPath = path.resolve(workflowArg);
  const mode = parseMode(stringFlag(parsed, "mode") ?? "audit");
  const concurrency = numberFlag(parsed, "concurrency");
  const tokenBudget = numberFlag(parsed, "token-budget") ?? null;
  const args = parsed.flags.args ? JSON.parse(String(parsed.flags.args)) : undefined;
  const runId = stringFlag(parsed, "run-id") ?? generateRunId();
  const runDir = await createRunArtifacts(cwd, runId, workflowPath);
  const script = await readFile(workflowPath, "utf8");
  const runner = new CodexCliAgentRunner({ codexBin: stringFlag(parsed, "codex-bin") });
  const eventWrites: Array<Promise<void>> = [];

  console.log(`◆ Workflow run ${runId}`);
  console.log(`  cwd: ${cwd}`);
  console.log(`  artifacts: ${runDir}`);

  try {
    const result = await runWorkflow(script, {
      cwd,
      runId,
      artifactsDir: runDir,
      mode,
      args,
      concurrency,
      tokenBudget,
      agentRunner: runner,
      onEvent(event) {
        eventWrites.push(appendEvent(runDir, event));
        if (event.type === "phase") console.log(`  phase: ${event.title}`);
        if (event.type === "agent_start") console.log(`  agent start: ${event.label}`);
        if (event.type === "agent_end") console.log(`  agent done: ${event.label}`);
        if (event.type === "agent_error") console.log(`  agent error: ${event.label}: ${event.error}`);
        if (event.type === "log") console.log(`  log: ${event.message}`);
      }
    });
    await Promise.all(eventWrites);
    await writeRunStatus(runDir, result);
    console.log(`✓ Workflow ${result.meta.name} completed with ${result.agentCount} agent(s)`);
    console.log(`  summary: ${path.join(runDir, "summary.md")}`);
  } catch (error) {
    await Promise.allSettled(eventWrites);
    await writeFailedStatus(runDir, error);
    throw error;
  }
}

async function createCommand(parsed: ParsedArgs): Promise<void> {
  const goal = parsed.positional[0];
  const out = stringFlag(parsed, "out");
  if (!goal) throw new Error("create requires <goal>");
  if (!out) throw new Error("create requires --out <workflow.js>");
  const cwd = path.resolve(stringFlag(parsed, "cwd") ?? process.cwd());
  await createWorkflow({
    goal,
    out,
    cwd,
    codexBin: stringFlag(parsed, "codex-bin")
  });
  console.log(`✓ Created workflow ${path.resolve(out)}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0]?.startsWith("-")) {
    const parsed = parseArgs(["help", ...argv]);
    return { ...parsed, command: undefined };
  }
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index];
    if (item === "-h") {
      flags.h = true;
      continue;
    }
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const equals = item.indexOf("=");
    if (equals !== -1) {
      flags[item.slice(2, equals)] = item.slice(equals + 1);
      continue;
    }
    const key = item.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index++;
    } else {
      flags[key] = true;
    }
  }
  return { command, positional, flags };
}

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  if (value === undefined || value === true) return undefined;
  return String(value);
}

function numberFlag(parsed: ParsedArgs, key: string): number | undefined {
  const value = stringFlag(parsed, key);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`--${key} must be a number`);
  return number;
}

function parseMode(value: string): WorkflowMode {
  if (value === "audit" || value === "patch") return value;
  throw new Error("--mode must be audit or patch");
}

function generateRunId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function printHelp(): void {
  console.log(`codex-workflow

Usage:
  codex-workflow run <workflow.js> [--cwd <repo>] [--mode audit|patch] [--concurrency 4]
  codex-workflow create "<goal>" --out workflows/<name>.js [--cwd <repo>]

Options:
  --codex-bin <path>       Override Codex executable
  --args <json>            JSON value exposed as workflow global args
  --token-budget <number>  Approximate token budget for subagent outputs
`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
