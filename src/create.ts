import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseWorkflowScript } from "./safe-script.ts";
import { runCommand } from "./codex-adapter.ts";

export interface CreateWorkflowOptions {
  goal: string;
  out: string;
  cwd: string;
  codexBin?: string;
}

export async function createWorkflow(options: CreateWorkflowOptions): Promise<void> {
  const codexBin = options.codexBin ?? process.env.CODEX_WORKFLOW_CODEX_BIN ?? "codex";
  const outputPath = path.resolve(options.out);
  const tempPath = `${outputPath}.tmp`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  const prompt = [
    "Create a deterministic JavaScript codex-workflow script for this goal.",
    "Return only raw JavaScript with no Markdown fences.",
    "The first statement must be: export const meta = { name: 'short_snake_case', description: '...' }",
    "Available globals: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, budget.",
    "Every workflow must call agent() at least once.",
    "Use write: false unless the goal explicitly requires code edits.",
    "",
    `Goal: ${options.goal}`
  ].join("\n");
  const result = await runCommand(
    codexBin,
    [
      "--ask-for-approval",
      "never",
      "exec",
      "-C",
      options.cwd,
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "-o",
      tempPath,
      "-"
    ],
    { cwd: options.cwd, input: prompt }
  );
  if (result.code !== 0) throw new Error(`codex workflow creation failed: ${result.stderr.trim() || result.stdout.trim()}`);
  const generated = stripMarkdownFence(await readFile(tempPath, "utf8"));
  parseWorkflowScript(generated);
  await writeFile(outputPath, generated.endsWith("\n") ? generated : `${generated}\n`, "utf8");
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : trimmed;
}
