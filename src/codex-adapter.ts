import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentOptions, AgentRunContext, AgentRunResult, AgentRunner } from "./types.ts";
import { validateJsonSchema } from "./schema.ts";

export interface CodexCliAgentRunnerOptions {
  codexBin?: string;
}

export class CodexCliAgentRunner implements AgentRunner {
  codexBin: string;

  constructor(options: CodexCliAgentRunnerOptions = {}) {
    this.codexBin = options.codexBin ?? process.env.CODEX_WORKFLOW_CODEX_BIN ?? "codex";
  }

  async run(prompt: string, options: AgentOptions, context: AgentRunContext): Promise<AgentRunResult> {
    const label = options.label ?? "agent";
    const safeLabel = sanitizeLabel(label);
    const artifactDir = path.join(context.artifactsDir, "agents", safeLabel);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "prompt.md"), buildPrompt(prompt, options), "utf8");

    const write = options.write === true;
    const execution = write ? await this.prepareWorktree(context.cwd, context.runId, safeLabel) : undefined;
    const execCwd = execution?.worktreePath ?? context.cwd;
    const outputLastMessage = path.join(artifactDir, "last-message.txt");
    const stdoutPath = path.join(artifactDir, "stdout.jsonl");
    const stderrPath = path.join(artifactDir, "stderr.txt");
    const args = [
      "--ask-for-approval",
      "never",
      "exec",
      "-C",
      execCwd,
      "--sandbox",
      write ? "workspace-write" : "read-only",
      "--color",
      "never",
      "--json",
      "-o",
      outputLastMessage
    ];

    if (options.schema) {
      const schemaPath = path.join(artifactDir, "schema.json");
      await writeFile(schemaPath, JSON.stringify(toCodexOutputSchema(options.schema), null, 2), "utf8");
      args.push("--output-schema", schemaPath);
    }
    args.push("-");

    const commandResult = await runCommand(this.codexBin, args, {
      cwd: execCwd,
      input: buildPrompt(prompt, options)
    });
    await writeFile(stdoutPath, commandResult.stdout, "utf8");
    await writeFile(stderrPath, commandResult.stderr, "utf8");

    if (commandResult.code !== 0) {
      throw new Error(`codex exec failed with code ${commandResult.code}: ${commandResult.stderr.trim() || commandResult.stdout.trim()}`);
    }

    const lastMessage = await readFile(outputLastMessage, "utf8");
    const result = options.schema ? parseStructuredResult(lastMessage, options.schema) : lastMessage.trim();

    let patchPath: string | undefined;
    if (write && execution) {
      const patch = await runCommand("git", ["diff", "--binary"], { cwd: execution.worktreePath });
      patchPath = path.join(artifactDir, "patch.diff");
      await writeFile(patchPath, patch.stdout, "utf8");
      const status = await runCommand("git", ["status", "--short"], { cwd: execution.worktreePath });
      await writeFile(path.join(artifactDir, "git-status.txt"), status.stdout, "utf8");
    }

    const resultEnvelope: AgentRunResult = {
      label,
      role: options.role,
      write,
      result,
      artifactDir,
      patchPath,
      worktreePath: execution?.worktreePath,
      branch: execution?.branch
    };
    await writeFile(path.join(artifactDir, "result.json"), JSON.stringify(resultEnvelope, null, 2), "utf8");
    return resultEnvelope;
  }

  async prepareWorktree(cwd: string, runId: string, safeLabel: string): Promise<{ worktreePath: string; branch: string }> {
    const head = await runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd });
    if (head.code !== 0) throw new Error("patch mode requires the target repository to have at least one commit");
    const worktreePath = path.join(cwd, ".codex-workflows", "worktrees", runId, safeLabel);
    const branch = `codex-workflow/${runId}/${safeLabel}`;
    await mkdir(path.dirname(worktreePath), { recursive: true });
    const added = await runCommand("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], { cwd });
    if (added.code !== 0) throw new Error(`failed to create worktree: ${added.stderr.trim() || added.stdout.trim()}`);
    return { worktreePath, branch };
  }
}

export function sanitizeLabel(label: string): string {
  const text = label.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return text || "agent";
}

export function toCodexOutputSchema(schema: AgentOptions["schema"]): AgentOptions["schema"] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const output = { ...schema };
  const isObject = output.type === "object" || output.properties !== undefined;
  if (isObject) {
    output.additionalProperties = false;
    const properties = output.properties ?? {};
    output.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, toCodexOutputSchema(value) as NonNullable<AgentOptions["schema"]>])
    );
  }
  if (output.items) output.items = toCodexOutputSchema(output.items);
  return output;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; input?: string }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function parseStructuredResult(lastMessage: string, schema: AgentOptions["schema"]): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastMessage);
  } catch (error) {
    throw new Error(`structured output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validation = validateJsonSchema(parsed, schema);
  if (!validation.ok) throw new Error(`structured output failed schema validation: ${validation.errors.join("; ")}`);
  return parsed;
}

function buildPrompt(prompt: string, options: AgentOptions): string {
  const lines = [
    "You are a Codex workflow subagent.",
    options.label ? `Task label: ${options.label}` : undefined,
    options.role ? `Role: ${options.role}` : undefined,
    options.scope ? `Scope: ${Array.isArray(options.scope) ? options.scope.join(", ") : options.scope}` : undefined,
    options.write
      ? "Write access is allowed only inside your assigned workspace. Do not merge or apply changes elsewhere."
      : "This is a read-only task. Do not modify files.",
    prompt
  ].filter(Boolean);
  return lines.join("\n\n");
}
