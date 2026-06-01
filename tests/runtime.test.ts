import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseWorkflowScript } from "../src/safe-script.ts";
import { runWorkflow } from "../src/runtime.ts";
import type { AgentOptions, AgentRunContext, AgentRunResult, AgentRunner } from "../src/types.ts";

class FakeRunner implements AgentRunner {
  calls: Array<{ prompt: string; options: AgentOptions }> = [];

  async run(prompt: string, options: AgentOptions, context: AgentRunContext): Promise<AgentRunResult> {
    this.calls.push({ prompt, options });
    if (prompt.includes("fail")) throw new Error("planned failure");
    return {
      label: options.label ?? "agent",
      role: options.role,
      write: options.write === true,
      result: `${options.label}:${prompt}:${context.mode}`,
      artifactDir: path.join(context.artifactsDir, "agents", options.label ?? "agent")
    };
  }
}

test("parseWorkflowScript accepts literal meta and extracts body", () => {
  const parsed = parseWorkflowScript(`
    export const meta = {
      name: 'inspect_project',
      description: 'Inspect project',
      phases: [{ title: 'Scan' }]
    }

    phase('Scan')
    return await agent('hello', { label: 'one', write: false })
  `);
  assert.equal(parsed.meta.name, "inspect_project");
  assert.match(parsed.body, /phase/);
});

test("parseWorkflowScript rejects unsafe script shapes", () => {
  assert.throws(() => parseWorkflowScript("const meta = {}"), /first statement/);
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: makeName(), description: 'x' }\nreturn 1"),
    /function calls/
  );
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: 'x', description: 'x' }\nconst now = Date.now()\nreturn now"
      ),
    /Date\.now/
  );
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: 'x', description: 'x' }\nconst value = Math.random()\nreturn value"
      ),
    /Math\.random/
  );
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: 'x', description: 'x' }\nconst fs = require('node:fs')\nreturn fs"
      ),
    /require/
  );
});

test("parallel preserves input order and failed branches become null", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cw-runtime-"));
  const runner = new FakeRunner();
  const script = `
    export const meta = { name: 'parallel_test', description: 'Parallel test' }
    phase('Run')
    const values = await parallel([
      () => agent('first', { label: 'a', write: false }),
      () => agent('fail second', { label: 'b', write: false }),
      () => agent('third', { label: 'c', write: false })
    ])
    return values
  `;
  const result = await runWorkflow(script, {
    cwd,
    runId: "run",
    artifactsDir: cwd,
    mode: "audit",
    agentRunner: runner
  });
  assert.deepEqual(result.result, ["a:first:audit", null, "c:third:audit"]);
  assert.equal(result.agentCount, 3);
  assert.equal(result.phases[0], "Run");
});

test("pipeline runs stages sequentially per item", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cw-pipeline-"));
  const runner = new FakeRunner();
  const script = `
    export const meta = { name: 'pipeline_test', description: 'Pipeline test' }
    const values = await pipeline(
      [1, 2],
      (value) => value + 1,
      (value) => agent('value ' + value, { label: 'item-' + value, write: false })
    )
    return values
  `;
  const result = await runWorkflow(script, {
    cwd,
    runId: "run",
    artifactsDir: cwd,
    mode: "audit",
    agentRunner: runner
  });
  assert.deepEqual(result.result, ["item-2:value 2:audit", "item-3:value 3:audit"]);
});

test("audit mode blocks write agents", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cw-audit-"));
  const runner = new FakeRunner();
  const script = `
    export const meta = { name: 'audit_block', description: 'Audit block' }
    return await agent('edit', { label: 'edit', write: true })
  `;
  const result = await runWorkflow(script, {
    cwd,
    runId: "run",
    artifactsDir: cwd,
    mode: "audit",
    agentRunner: runner
  });
  assert.equal(result.result, null);
  assert.equal(runner.calls.length, 0);
  assert.match(result.logs[0], /write access/);
});

test("workflow must call at least one agent", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cw-empty-"));
  const runner = new FakeRunner();
  const script = `
    export const meta = { name: 'empty', description: 'Empty' }
    return { ok: true }
  `;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        cwd,
        runId: "run",
        artifactsDir: cwd,
        mode: "audit",
        agentRunner: runner
      }),
    /must call agent/
  );
});
