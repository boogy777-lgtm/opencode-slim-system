import { createHash } from "node:crypto"
import { STOCK_PROMPT_HASHES } from "./stock-prompts.js"

/** @param {string} text */
export function promptHash(text) {
  return createHash("sha256").update(text).digest("hex")
}

/**
 * Exact stock snapshots only. Never use substring markers: a custom prompt or another plugin
 * can include those markers plus user/safety instructions. Unknown versions fail closed.
 * @param {Array<import("@opencode/ai").SystemPart>} system
 * @param {string} replacement
 */
export function replaceSystemPrompt(system, replacement) {
  const first = system[0]
  if (!first || first.metadata !== undefined || !STOCK_PROMPT_HASHES.has(promptHash(first.text))) return false
  system[0] = { ...first, text: replacement }
  return true
}
