import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexCliAgentRunner, toCodexOutputSchema } from "../src/codex-adapter.ts";

test("read-only agent invokes codex exec with read-only sandbox and validates schema", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "cw-adapter-"));
  const fakeCodex = await createFakeCodex(temp, {
    output: { ok: true, summary: "done" }
  });
  const runner = new CodexCliAgentRunner({ codexBin: fakeCodex });
  const result = await runner.run(
    "inspect",
    {
      label: "schema agent",
      role: "explorer",
      write: false,
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          summary: { type: "string" }
        },
        required: ["ok", "summary"]
      }
    },
    {
      cwd: temp,
      runId: "run",
      artifactsDir: path.join(temp, ".codex-workflows", "runs", "run"),
      mode: "audit"
    }
  );
  const invocation = JSON.parse(await readFile(path.join(temp, "invocation.json"), "utf8"));
  assert.ok(invocation.args.includes("exec"));
  assert.ok(invocation.args.includes("--sandbox"));
  assert.equal(invocation.args[invocation.args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(invocation.args[invocation.args.indexOf("--ask-for-approval") + 1], "never");
  assert.deepEqual(result.result, { ok: true, summary: "done" });
});

test("schema validation rejects invalid structured output", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "cw-schema-"));
  const fakeCodex = await createFakeCodex(temp, {
    output: { ok: "yes" }
  });
  const runner = new CodexCliAgentRunner({ codexBin: fakeCodex });
  await assert.rejects(
    () =>
      runner.run(
        "inspect",
        {
          label: "bad schema",
          write: false,
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"]
          }
        },
        {
          cwd: temp,
          runId: "run",
          artifactsDir: path.join(temp, ".codex-workflows", "runs", "run"),
          mode: "audit"
        }
      ),
    /schema validation/
  );
});

test("toCodexOutputSchema makes object schemas strict recursively", () => {
  const schema = toCodexOutputSchema({
    type: "object",
    properties: {
      ok: { type: "boolean" },
      nested: {
        type: "object",
        properties: {
          name: { type: "string" }
        }
      }
    }
  });
  assert.equal(schema?.additionalProperties, false);
  assert.equal(schema?.properties?.nested.additionalProperties, false);
});

async function createFakeCodex(dir: string, options: { output: unknown }): Promise<string> {
  const fakePath = path.join(dir, "fake-codex.mjs");
  await mkdir(dir, { recursive: true });
  await writeFile(
    fakePath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
let stdin = ''
try { stdin = readFileSync(0, 'utf8') } catch {}
writeFileSync(${JSON.stringify(path.join(dir, "invocation.json"))}, JSON.stringify({ args, stdin }, null, 2))
const outputIndex = args.indexOf('-o')
if (outputIndex !== -1) {
  writeFileSync(args[outputIndex + 1], JSON.stringify(${JSON.stringify(options.output)}, null, 2))
}
console.log(JSON.stringify({ type: 'done' }))
`,
    "utf8"
  );
  await chmod(fakePath, 0o755);
  return fakePath;
}
