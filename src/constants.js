import path from "node:path"
import os from "node:os"

// Separate from V1: its persisted descriptions use incompatible argument names and tool IDs.
export const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode", "slim-system-v2",
)

export const PLACEHOLDERS = {
  "{{year}}": () => new Date().getFullYear().toString(),
}

export const BASE_TOOL_IDS = [
  "edit", "glob", "grep", "patch", "question", "read", "shell", "skill", "subagent",
  "todowrite", "webfetch", "websearch", "write",
]
