#!/usr/bin/env node
// Regenerate src/defaults.js from tool/ and prompt/ directories.
// Usage: node scripts/gen-defaults.js

import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TOOL_DIR = path.join(ROOT, "tool")
const PROMPT_FILE = path.join(ROOT, "prompt", "default.txt")

function escapeForTs(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\${/g, "\\${")
}

const prompt = readFileSync(PROMPT_FILE, "utf-8").trimEnd()

const toolNames = readdirSync(TOOL_DIR)
  .filter((f) => f.endsWith(".txt"))
  .map((f) => f.slice(0, -4))
  .sort()

const lines = [
  "// Auto-generated from tool/ and prompt/ directories.",
  "// Regenerate: node scripts/gen-defaults.js",
  "",
  "export const DEFAULT_SYSTEM_PROMPT = `" + escapeForTs(prompt) + "`",
  "",
  "export const DEFAULT_TOOL_DESCRIPTIONS = {",
]

for (const name of toolNames) {
  const content = readFileSync(path.join(TOOL_DIR, `${name}.txt`), "utf-8").trimEnd()
  lines.push(`  "${name}": \`${escapeForTs(content)}\`,`)
}

lines.push("}")
lines.push("")

const totalChars = toolNames.reduce((sum, n) => {
  return sum + readFileSync(path.join(TOOL_DIR, `${n}.txt`), "utf-8").trimEnd().length
}, 0)
const avgChars = toolNames.length > 0 ? Math.round(totalChars / toolNames.length) : 0
lines.push(`// Tool count: ${toolNames.length} | Total chars: ${totalChars} | Avg chars: ${avgChars}`)

writeFileSync(path.join(ROOT, "src", "defaults.js"), lines.join("\n"))
console.log(`Wrote ${toolNames.length} tools, ${totalChars} chars total, ${avgChars} avg to src/defaults.js`)
