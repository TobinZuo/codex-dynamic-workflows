import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexCliAgentRunner } from "../src/codex-adapter.ts";
import { runCommand } from "../src/codex-adapter.ts";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("patch agent edits an isolated worktree and writes patch.diff", async () => {
  const repo = await createGitRepo("cw-worktree-");
  const fakeCodex = await createPatchFakeCodex(repo);
  const artifactsDir = path.join(repo, ".codex-workflows", "runs", "run");
  const runner = new CodexCliAgentRunner({ codexBin: fakeCodex });
  const result = await runner.run(
    "edit file",
    { label: "edit file", role: "worker", write: true },
    { cwd: repo, runId: "run", artifactsDir, mode: "patch" }
  );
  assert.ok(result.worktreePath);
  assert.ok(result.patchPath);
  const mainFile = await readFile(path.join(repo, "file.txt"), "utf8");
  assert.equal(mainFile, "original\n");
  const patch = await readFile(result.patchPath as string, "utf8");
  assert.match(patch, /changed/);
});

test("CLI run writes artifacts for an audit workflow", async () => {
  const repo = await createGitRepo("cw-cli-");
  const fakeCodex = await createStaticFakeCodex(repo);
  const workflow = path.join(repo, "workflow.js");
  await writeFile(
    workflow,
    `export const meta = { name: 'cli_test', description: 'CLI test' }
const result = await agent('inspect', { label: 'inspect', write: false })
return { result }
`,
    "utf8"
  );
  const cli = path.join(repoRoot, "src", "cli.ts");
  const result = await runCommand(
    process.execPath,
    [cli, "run", workflow, "--cwd", repo, "--run-id", "testrun", "--codex-bin", fakeCodex],
    { cwd: repo }
  );
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(await readFile(path.join(repo, ".codex-workflows", "runs", "testrun", "events.jsonl"), "utf8"), /agent_start/);
  assert.match(await readFile(path.join(repo, ".codex-workflows", "runs", "testrun", "summary.md"), "utf8"), /cli_test/);
  assert.match(await readFile(path.join(repo, ".gitignore"), "utf8"), /\.codex-workflows\/runs\//);
});

test("CLI create writes a parser-valid workflow script", async () => {
  const repo = await createGitRepo("cw-create-");
  const fakeCodex = await createWorkflowFakeCodex(repo);
  const out = path.join(repo, "workflows", "created.js");
  const cli = path.join(repoRoot, "src", "cli.ts");
  const result = await runCommand(
    process.execPath,
    [cli, "create", "inspect this repo", "--cwd", repo, "--out", out, "--codex-bin", fakeCodex],
    { cwd: repo }
  );
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const created = await readFile(out, "utf8");
  assert.match(created, /export const meta/);
  assert.match(created, /agent\(/);
});

async function createGitRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), prefix));
  await runCommand("git", ["init"], { cwd: repo });
  await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await runCommand("git", ["config", "user.name", "Test User"], { cwd: repo });
  await writeFile(path.join(repo, "file.txt"), "original\n", "utf8");
  await runCommand("git", ["add", "file.txt"], { cwd: repo });
  const commit = await runCommand("git", ["commit", "-m", "initial"], { cwd: repo });
  assert.equal(commit.code, 0, commit.stderr);
  return repo;
}

async function createPatchFakeCodex(dir: string): Promise<string> {
  const fakePath = path.join(dir, "fake-patch-codex.mjs");
  await mkdir(dir, { recursive: true });
  await writeFile(
    fakePath,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const cwd = args[args.indexOf('-C') + 1]
writeFileSync(join(cwd, 'file.txt'), 'changed\\n')
const outputIndex = args.indexOf('-o')
if (outputIndex !== -1) writeFileSync(args[outputIndex + 1], 'edited')
console.log(JSON.stringify({ type: 'done' }))
`,
    "utf8"
  );
  await chmod(fakePath, 0o755);
  return fakePath;
}

async function createStaticFakeCodex(dir: string): Promise<string> {
  const fakePath = path.join(dir, "fake-static-codex.mjs");
  await mkdir(dir, { recursive: true });
  await writeFile(
    fakePath,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const outputIndex = args.indexOf('-o')
if (outputIndex !== -1) writeFileSync(args[outputIndex + 1], 'static result')
console.log(JSON.stringify({ type: 'done' }))
`,
    "utf8"
  );
  await chmod(fakePath, 0o755);
  return fakePath;
}

async function createWorkflowFakeCodex(dir: string): Promise<string> {
  const fakePath = path.join(dir, "fake-create-codex.mjs");
  await mkdir(dir, { recursive: true });
  await writeFile(
    fakePath,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const outputIndex = args.indexOf('-o')
const workflow = "export const meta = { name: 'created_workflow', description: 'Created workflow' }\\nreturn await agent('inspect', { label: 'inspect', write: false })\\n"
if (outputIndex !== -1) writeFileSync(args[outputIndex + 1], workflow)
console.log('created')
`,
    "utf8"
  );
  await chmod(fakePath, 0o755);
  return fakePath;
}
