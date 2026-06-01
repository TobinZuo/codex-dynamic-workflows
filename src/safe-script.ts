import vm from "node:vm";
import type { WorkflowMeta } from "./types.ts";

const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/\bimport\s*(?:\(|[\w{*"'])/, "import is unavailable in workflow scripts"],
  [/\bexport\b/, "export is only allowed for the first meta statement"],
  [/\brequire\s*\(/, "require() is unavailable in workflow scripts"],
  [/\bfs\b/, "fs is unavailable in workflow scripts"],
  [/\bfetch\s*\(/, "network APIs are unavailable in workflow scripts"],
  [/\bXMLHttpRequest\b/, "network APIs are unavailable in workflow scripts"],
  [/\bWebSocket\b/, "network APIs are unavailable in workflow scripts"],
  [/\bDate\s*\.\s*now\s*\(/, "Date.now() is unavailable in workflow scripts"],
  [/\bnew\s+Date\s*\(/, "new Date() is unavailable in workflow scripts"],
  [/\bMath\s*\.\s*random\s*\(/, "Math.random() is unavailable in workflow scripts"],
  [/\beval\s*\(/, "eval() is unavailable in workflow scripts"],
  [/\bFunction\s*\(/, "Function() is unavailable in workflow scripts"],
  [/\bconstructor\b/, "constructor access is unavailable in workflow scripts"],
  [/\bprototype\b/, "prototype access is unavailable in workflow scripts"],
  [/\b__proto__\b/, "__proto__ access is unavailable in workflow scripts"]
];

export interface ParsedWorkflowScript {
  meta: WorkflowMeta;
  body: string;
}

export function parseWorkflowScript(script: string): ParsedWorkflowScript {
  const text = script.trimStart();
  if (!text.startsWith("export const meta")) {
    throw new Error("`export const meta = { name, description }` must be the first statement");
  }

  const equalsIndex = text.indexOf("=");
  if (equalsIndex === -1) throw new Error("meta export must assign a literal object");
  const objectStart = text.indexOf("{", equalsIndex);
  if (objectStart === -1) throw new Error("meta must be a literal object");

  const objectEnd = findBalancedEnd(text, objectStart);
  const metaSource = text.slice(objectStart, objectEnd + 1);
  assertLiteralMetaSource(metaSource);
  const meta = evaluateMeta(metaSource);
  validateMeta(meta);

  let bodyStart = objectEnd + 1;
  while (/\s/.test(text[bodyStart] ?? "")) bodyStart++;
  if (text[bodyStart] === ";") bodyStart++;
  const body = text.slice(bodyStart);
  assertSafeWorkflowBody(body);
  return { meta, body };
}

export function assertSafeWorkflowBody(body: string): void {
  const stripped = stripStringsAndComments(body);
  for (const [pattern, message] of FORBIDDEN_PATTERNS) {
    if (pattern.test(stripped)) throw new Error(message);
  }
}

function assertLiteralMetaSource(source: string): void {
  const stripped = stripStringsAndComments(source);
  const forbidden: Array<[RegExp, string]> = [
    [/\.\.\./, "spread is not allowed in meta"],
    [/=>/, "functions are not allowed in meta"],
    [/\bfunction\b/, "functions are not allowed in meta"],
    [/\bnew\b/, "constructors are not allowed in meta"],
    [/\(/, "function calls are not allowed in meta"],
    [/\bDate\b/, "Date is not allowed in meta"],
    [/\bMath\b/, "Math is not allowed in meta"],
    [/\bimport\b/, "import is not allowed in meta"],
    [/\brequire\b/, "require is not allowed in meta"],
    [/\bconstructor\b/, "constructor is not allowed in meta"],
    [/\bprototype\b/, "prototype is not allowed in meta"],
    [/\b__proto__\b/, "__proto__ is not allowed in meta"]
  ];
  for (const [pattern, message] of forbidden) {
    if (pattern.test(stripped)) throw new Error(message);
  }
  if (source.includes("${")) throw new Error("template interpolation is not allowed in meta");
}

function evaluateMeta(source: string): unknown {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false }
  });
  return new vm.Script(`(${source})`).runInContext(context, { timeout: 1000 });
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim()) {
    throw new Error("meta.description must be a non-empty string");
  }
  if (value.whenToUse !== undefined && typeof value.whenToUse !== "string") {
    throw new Error("meta.whenToUse must be a string");
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof phase.title !== "string" || !phase.title.trim()) {
        throw new Error("each meta phase must have a non-empty title string");
      }
    }
  }
}

function findBalancedEnd(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  throw new Error("meta object is not balanced");
}

function stripStringsAndComments(source: string): string {
  let output = "";
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      output += char === "\n" ? "\n" : " ";
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      output += /\s/.test(char) ? char : " ";
      if (char === "*" && next === "/") {
        output += " ";
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      output += /\s/.test(char) ? char : " ";
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      output += "  ";
      lineComment = true;
      index++;
      continue;
    }
    if (char === "/" && next === "*") {
      output += "  ";
      blockComment = true;
      index++;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      output += " ";
      quote = char;
      continue;
    }
    output += char;
  }
  return output;
}
