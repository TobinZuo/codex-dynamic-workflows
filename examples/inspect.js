export const meta = {
  name: "inspect_project",
  description: "Inspect a repository and summarize its main modules",
  phases: [{ title: "Scan" }, { title: "Summarize" }]
}

phase("Scan")
const inventory = await agent(
  "Inspect the repository structure. Identify the main directories, package files, and likely entry points. Do not modify files.",
  {
    label: "repo inventory",
    role: "explorer",
    write: false
  }
)

phase("Summarize")
const summary = await agent(
  "Summarize the main modules from this inventory:\n" + inventory,
  {
    label: "module summary",
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
  }
)

return { inventory, summary }
