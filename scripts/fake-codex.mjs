#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const execIndex = args.indexOf("exec");
const execArgs = execIndex === -1 ? args : args.slice(execIndex + 1);
const cwd = valueAfter(execArgs, "-C") ?? process.cwd();
const outputPath = valueAfter(execArgs, "-o");
const schemaPath = valueAfter(execArgs, "--output-schema");
const stdin = readStdin();
const stats = inspectRepo(cwd);

let output;
if (schemaPath) {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  output = JSON.stringify(buildSchemaOutput(schema, stats, stdin), null, 2);
} else {
  output = [
    `Fake Codex inspected ${cwd}.`,
    `Files: ${stats.files}. Directories: ${stats.dirs}.`,
    `Top-level entries: ${stats.topLevel.join(", ") || "none"}.`,
    `Prompt excerpt: ${stdin.slice(0, 220).replace(/\s+/g, " ")}`
  ].join("\n");
}

if (outputPath) writeFileSync(outputPath, output);
console.log(JSON.stringify({ type: "fake_codex_done", cwd, outputPath, schemaPath }));

function valueAfter(items, key) {
  const index = items.indexOf(key);
  return index === -1 ? undefined : items[index + 1];
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function inspectRepo(root) {
  const topLevel = [];
  let files = 0;
  let dirs = 0;
  walk(root, 0);
  return { files, dirs, topLevel };

  function walk(current, depth) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".codex-workflows" || entry.name === "node_modules") continue;
      if (depth === 0) topLevel.push(entry.name);
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        dirs++;
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        files++;
      } else {
        try {
          if (statSync(fullPath).isFile()) files++;
        } catch {
          // Ignore unreadable entries in fake mode.
        }
      }
    }
  }
}

function buildSchemaOutput(schema, stats, prompt) {
  const properties = schema.properties ?? {};
  const output = {};
  for (const [key, property] of Object.entries(properties)) {
    if (property.type === "boolean") output[key] = true;
    else if (property.type === "array") output[key] = [`Fake finding for ${key}: inspected ${stats.files} files.`];
    else output[key] = `Fake ${key}: ${stats.files} files, ${stats.dirs} directories. Prompt: ${prompt.slice(0, 120)}`;
  }
  return output;
}
