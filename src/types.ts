export type WorkflowMode = "audit" | "patch";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export interface AgentOptions {
  label?: string;
  role?: "explorer" | "worker" | "verifier" | string;
  scope?: string | string[];
  write?: boolean;
  schema?: JsonSchema;
  model?: string;
}

export interface AgentRunContext {
  cwd: string;
  runId: string;
  artifactsDir: string;
  mode: WorkflowMode;
}

export interface AgentRunResult {
  label: string;
  role?: string;
  write: boolean;
  result: unknown;
  artifactDir: string;
  patchPath?: string;
  worktreePath?: string;
  branch?: string;
}

export interface AgentRunner {
  run(prompt: string, options: AgentOptions, context: AgentRunContext): Promise<AgentRunResult>;
}

export type WorkflowEvent =
  | { type: "log"; message: string; at: string }
  | { type: "phase"; title: string; at: string }
  | { type: "agent_start"; label: string; phase?: string; prompt: string; options: AgentOptions; at: string }
  | { type: "agent_end"; label: string; phase?: string; result: unknown; at: string }
  | { type: "agent_error"; label: string; phase?: string; error: string; at: string }
  | { type: "workflow_error"; error: string; at: string };

export interface WorkflowRunOptions {
  cwd: string;
  runId: string;
  artifactsDir: string;
  mode: WorkflowMode;
  args?: unknown;
  concurrency?: number;
  tokenBudget?: number | null;
  agentRunner: AgentRunner;
  onEvent?: (event: WorkflowEvent) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
}
