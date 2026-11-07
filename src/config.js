import { readFile, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CONFIG_DIR, PLACEHOLDERS } from "./constants.js"
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_TOOL_DESCRIPTIONS } from "./defaults.js"

/** @param {string} text */
export function resolvePlaceholders(text) {
  for (const [key, resolve] of Object.entries(PLACEHOLDERS)) text = text.replaceAll(key, resolve())
  return text
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** @param {unknown} error */
function missing(error) {
  return isObject(error) && error.code === "ENOENT"
}

/** @param {string} file */
async function optionalText(file) {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

/** @param {string} value @param {string} directory */
function resolvePath(value, directory) {
  return path.resolve(directory, value.replace(/^~(?=$|[\\/])/, os.homedir()))
}

/** @param {unknown} options @param {string} directory */
export async function loadConfig(options, directory) {
  if (!isObject(options)) throw new TypeError("Slim System options must be an object")
  const keys = new Set(["exclude", "tools", "toolsDir", "configDir", "systemPrompt"])
  for (const key of Object.keys(options)) {
    if (!keys.has(key)) throw new TypeError(`Unknown Slim System option: ${key}; V1 reset is not supported`)
  }
  if (options.exclude !== undefined &&
      (!Array.isArray(options.exclude) || !options.exclude.every((id) => typeof id === "string"))) {
    throw new TypeError("exclude must be an array of tool IDs")
  }
  /** @type {Record<string, string>} */
  const overrides = Object.create(null)
  if (options.tools !== undefined) {
    if (!isObject(options.tools)) throw new TypeError("tools must map tool IDs to non-empty descriptions")
    for (const [id, text] of Object.entries(options.tools)) {
      if (typeof text !== "string" || !text.trim()) throw new TypeError("tools must map tool IDs to non-empty descriptions")
      overrides[id] = text
    }
  }
  for (const key of ["configDir", "toolsDir"]) {
    if (options[key] !== undefined && (typeof options[key] !== "string" || !options[key].trim())) {
      throw new TypeError(`${key} must be a non-empty path`)
    }
  }
  if (options.systemPrompt !== undefined && typeof options.systemPrompt !== "boolean") {
    throw new TypeError("systemPrompt must be a boolean")
  }
  const configDir = typeof options.configDir === "string" ? resolvePath(options.configDir, directory) : CONFIG_DIR
  const toolsDir = typeof options.toolsDir === "string"
    ? resolvePath(options.toolsDir, directory) : path.join(configDir, "tool")
  /** @type {Record<string, string>} */
  const tools = Object.assign(Object.create(null), DEFAULT_TOOL_DESCRIPTIONS)
  /** @type {import("node:fs").Dirent[]} */
  let files
  try {
    files = await readdir(toolsDir, { withFileTypes: true })
  } catch (error) {
    if (!missing(error)) throw error
    files = []
  }
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".txt")) continue
    const text = (await readFile(path.join(toolsDir, file.name), "utf8")).trimEnd()
    if (!text.trim()) throw new TypeError(`Empty tool description: ${file.name}`)
    tools[file.name.slice(0, -4)] = text
  }
  for (const [id, text] of Object.entries(overrides)) tools[id] = text
  for (const [id, text] of Object.entries(tools)) tools[id] = resolvePlaceholders(text)
  const prompt = (await optionalText(path.join(configDir, "prompt", "default.txt")))?.trimEnd() ?? DEFAULT_SYSTEM_PROMPT
  if (!prompt.trim()) throw new TypeError("System prompt must not be empty")
  return {
    tools,
    prompt: resolvePlaceholders(prompt),
    exclude: new Set(options.exclude ?? []),
    systemPrompt: options.systemPrompt === true,
  }
}
