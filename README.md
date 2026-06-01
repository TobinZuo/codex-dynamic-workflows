# codex-workflow

Claude-Code-style dynamic workflow orchestration for Codex CLI.

`codex-workflow` runs deterministic JavaScript workflow scripts that fan work
out to Codex CLI subagents, collect their outputs, and write auditable run
artifacts. It supports read-only audit workflows and patch workflows where
workers edit isolated git worktrees and return patch files.

This project is independent and is not affiliated with OpenAI or Anthropic.

## Usage

Install after publishing to npm:

```bash
npm install -g @tobinzuo/codex-dynamic-workflows
codex-workflow run examples/inspect.js --cwd /path/to/repo --mode audit
```

Local development:

```bash
node src/cli.ts run examples/inspect.js --cwd /path/to/repo --mode audit --concurrency 4
node src/cli.ts create "inspect this repository and summarize the main modules" --out workflows/inspect.js
```

Build the npm package:

```bash
npm install
npm run build
npm pack --dry-run
```

Publish to npm:

```bash
npm publish --access public
```

The package is scoped as `@tobinzuo/codex-dynamic-workflows` and publishes to
the public npm registry.

Set `CODEX_WORKFLOW_CODEX_BIN` to override the Codex executable. This is useful
for tests and CI fakes.

## Workflow Shape

```js
export const meta = {
  name: "repo_security_audit",
  description: "Audit security-sensitive areas",
  phases: [{ title: "Explore" }, { title: "Verify" }]
}

phase("Explore")
const findings = await parallel([
  () => agent("Inspect auth boundaries", {
    label: "auth scan",
    role: "explorer",
    scope: ["src/auth"],
    write: false
  }),
  () => agent("Inspect API validation", {
    label: "api scan",
    role: "explorer",
    scope: ["src/api"],
    write: false
  })
])

phase("Verify")
const verdict = await agent("Verify these findings:\n" + JSON.stringify(findings), {
  label: "adversarial review",
  role: "verifier",
  write: false,
  schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      summary: { type: "string" }
    },
    required: ["ok", "summary"]
  }
})

return { findings, verdict }
```

## Runtime Globals

- `agent(prompt, opts)` runs a Codex CLI subtask.
- `parallel(thunks)` runs `() => agent(...)` thunks concurrently and preserves result order.
- `pipeline(items, ...stages)` runs each item through sequential stages while items fan out.
- `phase(title)` marks progress groups.
- `log(message)` writes workflow-level log entries.
- `args`, `cwd`, and `budget` expose run input and token-budget accounting.

## Artifacts

Each run writes:

```text
.codex-workflows/
  runs/<runId>/
    workflow.js
    events.jsonl
    summary.md
    status.json
    agents/<label>/
      prompt.md
      result.json
      stdout.jsonl
      stderr.txt
      patch.diff
```

Patch mode never applies or merges worker diffs automatically.
