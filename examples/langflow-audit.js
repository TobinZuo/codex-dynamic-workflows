export const meta = {
  name: "langflow_parallel_audit",
  description: "Parallel architecture and risk audit for a large Langflow-style repository",
  phases: [{ title: "Explore" }, { title: "Synthesize" }]
}

phase("Explore")
const findings = await parallel([
  () => agent(
    "Inspect the repository layout, build/package files, major services, and likely runtime entry points. Do not modify files. Return concise findings with key paths.",
    {
      label: "repo map",
      role: "explorer",
      write: false
    }
  ),
  () => agent(
    "Inspect backend/server-side code organization, API boundaries, persistence, auth or secret-handling surfaces, and notable risks. Do not modify files. Return concise findings with key paths.",
    {
      label: "backend scan",
      role: "explorer",
      scope: ["src", "backend", "packages", "libs"],
      write: false
    }
  ),
  () => agent(
    "Inspect frontend/client-side code organization, state management, API usage, build setup, and notable risks. Do not modify files. Return concise findings with key paths.",
    {
      label: "frontend scan",
      role: "explorer",
      scope: ["frontend", "web", "client", "src"],
      write: false
    }
  ),
  () => agent(
    "Inspect tests, CI, dependency manifests, and developer tooling. Identify missing coverage or high-leverage validation commands. Do not modify files. Return concise findings with key paths.",
    {
      label: "quality scan",
      role: "explorer",
      scope: [".github", "tests", "pyproject.toml", "package.json"],
      write: false
    }
  )
])

phase("Synthesize")
const synthesis = await agent(
  "Synthesize these parallel audit findings into a compact report. Separate high-confidence repo facts from inferred risks. Include recommended next workflow if useful.\n\n" + JSON.stringify(findings, null, 2),
  {
    label: "audit synthesis",
    role: "verifier",
    write: false,
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        summary: { type: "string" },
        facts: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
        nextWorkflow: { type: "string" }
      },
      additionalProperties: false,
      required: ["ok", "summary", "facts", "risks", "nextWorkflow"]
    }
  }
)

return { findings, synthesis }
