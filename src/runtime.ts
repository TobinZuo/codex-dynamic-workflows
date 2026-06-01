import vm from "node:vm";
import type { AgentOptions, WorkflowEvent, WorkflowRunOptions, WorkflowRunResult } from "./types.ts";
import { parseWorkflowScript } from "./safe-script.ts";

type WorkflowEventWithoutAt = WorkflowEvent extends infer Event
  ? Event extends { at: string }
    ? Omit<Event, "at">
    : never
  : never;

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number;
  spent: number;
}

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const state: RuntimeState = { logs: [], phases: [], agentCount: 0, spent: 0 };
  const concurrency = clampConcurrency(options.concurrency);
  const limiter = createLimiter(concurrency);
  const pendingAgentRuns = new Set<Promise<unknown>>();

  const emit = (event: WorkflowEventWithoutAt) => {
    options.onEvent?.({ ...event, at: new Date().toISOString() } as WorkflowEvent);
  };

  const log = (message: unknown) => {
    const text = String(message);
    state.logs.push(text);
    emit({ type: "log", message: text });
  };

  const phase = (title: unknown) => {
    const text = requireString(title, "phase title");
    state.currentPhase = text;
    if (!state.phases.includes(text)) state.phases.push(text);
    emit({ type: "phase", title: text });
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => state.spent,
    remaining: () =>
      options.tokenBudget == null ? Number.POSITIVE_INFINITY : Math.max(0, options.tokenBudget - state.spent)
  });

  const agent = async (prompt: unknown, agentOptions: unknown = {}) => {
    if (budget.total !== null && budget.remaining() <= 0) throw new Error("workflow token budget exhausted");
    const taskPrompt = requireString(prompt, "agent prompt");
    const normalizedOptions = normalizeAgentOptions(agentOptions);
    const assignedPhase = state.currentPhase;
    const label = normalizedOptions.label?.trim() || defaultAgentLabel(assignedPhase, state.agentCount + 1);
    const run = limiter(async () => {
      state.agentCount++;
      if (normalizedOptions.write && options.mode === "audit") {
        const error = `agent ${label} requested write access while workflow mode is audit`;
        log(error);
        emit({ type: "agent_error", label, phase: assignedPhase, error });
        return null;
      }
      emit({ type: "agent_start", label, phase: assignedPhase, prompt: taskPrompt, options: normalizedOptions });
      try {
        const result = await options.agentRunner.run(taskPrompt, { ...normalizedOptions, label }, {
          cwd: options.cwd,
          runId: options.runId,
          artifactsDir: options.artifactsDir,
          mode: options.mode
        });
        state.spent += estimateTokens(result.result);
        emit({ type: "agent_end", label, phase: assignedPhase, result });
        return result.result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`agent ${label} failed: ${message}`);
        emit({ type: "agent_error", label, phase: assignedPhase, error: message });
        return null;
      }
    });
    pendingAgentRuns.add(run);
    run.finally(() => pendingAgentRuns.delete(run));
    return run;
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects functions, not promises. Wrap each call: () => agent(...)");
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`parallel[${index}] failed: ${message}`);
          return null;
        }
      })
    );
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions");
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            value = await stage(value, item, index);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log(`pipeline[${index}] failed: ${message}`);
            return null;
          }
        }
        return value;
      })
    );
  };

  const safeMath = Object.freeze(
    Object.fromEntries(Object.getOwnPropertyNames(Math).filter((key) => key !== "random").map((key) => [key, (Math as any)[key]]))
  );
  const context = vm.createContext(
    {
      agent,
      parallel,
      pipeline,
      phase,
      log,
      args: options.args,
      cwd: options.cwd,
      process: Object.freeze({ cwd: () => options.cwd }),
      budget,
      console: Object.freeze({
        log,
        info: log,
        warn: (message: unknown) => log(`[warn] ${String(message)}`),
        error: (message: unknown) => log(`[error] ${String(message)}`)
      }),
      JSON,
      Math: safeMath,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Set,
      Map,
      Promise
    },
    { codeGeneration: { strings: false, wasm: false } }
  );

  let result: unknown;
  try {
    result = await new vm.Script(`(async () => {\n${body}\n})()`, {
      filename: `${meta.name || "workflow"}.js`
    }).runInContext(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "workflow_error", error: message });
    throw error;
  } finally {
    await Promise.allSettled([...pendingAgentRuns]);
  }

  if (state.agentCount === 0) {
    throw new Error("workflow scripts must call agent() at least once");
  }
  assertStructuredCloneable(result, "workflow result");
  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    durationMs: Date.now() - started
  };
}

export function clampConcurrency(value: number | undefined): number {
  const fallback = Math.max(1, Math.min(16, ((globalThis.navigator as any)?.hardwareConcurrency ?? 8) - 2));
  const candidate = Number.isFinite(value) && value ? Number(value) : fallback;
  return Math.max(1, Math.min(16, Math.floor(candidate)));
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function normalizeAgentOptions(value: unknown): AgentOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("agent options must be an object");
  const input = value as AgentOptions;
  return {
    label: optionalString(input.label, "agent label"),
    role: optionalString(input.role, "agent role"),
    scope: normalizeScope(input.scope),
    write: input.write === true,
    schema: input.schema,
    model: optionalString(input.model, "agent model")
  };
}

function normalizeScope(value: unknown): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new TypeError("agent scope must be a string or array of strings");
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function assertStructuredCloneable(value: unknown, name: string): void {
  try {
    structuredClone(value);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`${name} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()?${detail}`);
  }
}
