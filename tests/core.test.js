import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "../src/index.js"
import { DEFAULT_TOOL_DESCRIPTIONS, DEFAULT_SYSTEM_PROMPT } from "../src/defaults.js"
import { BASE_TOOL_IDS, CONFIG_DIR } from "../src/constants.js"
import { loadConfig, resolvePlaceholders } from "../src/config.js"
import { promptHash, replaceSystemPrompt } from "../src/system.js"
import { STOCK_PROMPT_HASHES } from "../src/stock-prompts.js"

const root = path.resolve(import.meta.dirname, "..")
const stock = (name) => readFile(path.join(import.meta.dirname, "fixtures", "stock", `${name}.txt`), "utf8")
const tempRoot = process.platform === "win32" ? path.join(os.tmpdir(), "opencode") : os.tmpdir()

async function temporary(run) {
  await mkdir(tempRoot, { recursive: true })
  const directory = await mkdtemp(path.join(tempRoot, "slim-v2-test-"))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

async function setup(options, directory, agent = {}) {
  const hooks = new Map()
  const commands = new Map()
  const synthetics = []
  const context = {
    options: { configDir: path.join(directory, "config"), ...options },
    location: { directory },
    agent: { get: async () => ({ data: agent }) },
    session: {
      hook: async (name, callback) => {
        assert.equal(hooks.has(name), false, `duplicate ${name}`)
        hooks.set(name, callback)
        return { dispose: async () => hooks.delete(name) }
      },
      synthetic: async (input) => synthetics.push(input),
    },
    command: {
      transform: async (callback) => {
        const editor = { add: (command) => commands.set(command.name, command) }
        callback(editor)
        // A replay must remain deterministic and perform no one-time side effects.
        const first = [...commands.keys()]
        callback(editor)
        assert.deepEqual([...commands.keys()], first)
        return { dispose: async () => commands.clear() }
      },
    },
  }
  await plugin.setup(context)
  return { hooks, commands, synthetics }
}

function event(system = [{ type: "text", text: "custom instructions" }]) {
  return {
    sessionID: "session-test", agent: "build", model: { providerID: "local", id: "test" },
    system, messages: [{ role: "user", content: "keep history" }], options: { temperature: 0.3 },
    tools: {
      read: { description: "Stock read instructions. ".repeat(100), input: { type: "object", required: ["path"] } },
      shell: { description: "Stock shell instructions. ".repeat(100), input: { type: "object" } },
      mcp_read: { description: "MCP tool must remain unchanged", input: { type: "object" } },
      unknown: { description: "New builtin", input: { type: "object" } },
    },
  }
}

describe("V2 defaults", () => {
  it("covers exactly the explicit V2 tool requirement class", () => {
    assert.deepEqual(Object.keys(DEFAULT_TOOL_DESCRIPTIONS).sort(), [...BASE_TOOL_IDS].sort())
    for (const legacy of ["bash", "task", "apply_patch", "lsp", "plan_exit"]) {
      assert.equal(DEFAULT_TOOL_DESCRIPTIONS[legacy], undefined)
    }
  })
  it("matches every tool source and the system prompt source", async () => {
    const files = (await readdir(path.join(root, "tool"))).filter((name) => name.endsWith(".txt"))
    assert.equal(files.length, BASE_TOOL_IDS.length)
    for (const file of files) {
      assert.equal(DEFAULT_TOOL_DESCRIPTIONS[file.slice(0, -4)], (await readFile(path.join(root, "tool", file), "utf8")).trimEnd())
    }
    assert.equal(DEFAULT_SYSTEM_PROMPT, (await readFile(path.join(root, "prompt", "default.txt"), "utf8")).trimEnd())
  })
  it("contains no stale argument names, blanket delegation or unsupported placeholders", () => {
    for (const text of Object.values(DEFAULT_TOOL_DESCRIPTIONS)) {
      assert.doesNotMatch(text, /filePath|subagent_type|task_id|aft_safety|\$\{/)
      assert.ok(text.trim().length > 10)
    }
    assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /subagent-first|NEVER add comments/i)
  })
  it("resolves all occurrences of year without inventing shell/runtime data", () => {
    const year = String(new Date().getFullYear())
    assert.equal(resolvePlaceholders("{{year}} {{year}}"), `${year} ${year}`)
    assert.equal(resolvePlaceholders("${shell}"), "${shell}")
  })
  it("uses a separate V2 configuration directory", () => {
    assert.equal(path.basename(CONFIG_DIR), "slim-system-v2")
  })
})

describe("non-destructive configuration", () => {
  it("uses defaults without creating any files", () => temporary(async (directory) => {
    const config = await loadConfig({ configDir: path.join(directory, "missing") }, directory)
    assert.deepEqual(await readdir(directory), [])
    assert.equal(config.systemPrompt, false)
    assert.equal(config.tools.read, DEFAULT_TOOL_DESCRIPTIONS.read)
  }))
  it("merges files over defaults and inline overrides over files", () => temporary(async (directory) => {
    const toolsDir = path.join(directory, "descriptions")
    await mkdir(toolsDir)
    await writeFile(path.join(toolsDir, "read.txt"), "From file\n")
    await writeFile(path.join(toolsDir, "shell.txt"), "File shell\n")
    await writeFile(path.join(toolsDir, "mcp_custom.txt"), "Explicit custom description\n")
    await writeFile(path.join(toolsDir, "ignored.md"), "ignored")
    const config = await loadConfig({ toolsDir: "descriptions", configDir: "absent", tools: { read: "Inline read" } }, directory)
    assert.equal(config.tools.read, "Inline read")
    assert.equal(config.tools.shell, "File shell")
    assert.equal(config.tools.mcp_custom, "Explicit custom description")
    assert.equal(config.tools.grep, DEFAULT_TOOL_DESCRIPTIONS.grep)
    assert.equal(await readFile(path.join(toolsDir, "read.txt"), "utf8"), "From file\n")
  }))
  it("reads the V2 prompt and resolves placeholders consistently", () => temporary(async (directory) => {
    await mkdir(path.join(directory, "config", "prompt"), { recursive: true })
    await writeFile(path.join(directory, "config", "prompt", "default.txt"), "Prompt {{year}}\n")
    const config = await loadConfig({ configDir: "config", systemPrompt: true, tools: { read: "Read {{year}}" } }, directory)
    assert.equal(config.prompt, `Prompt ${new Date().getFullYear()}`)
    assert.equal(config.tools.read, `Read ${new Date().getFullYear()}`)
  }))
  it("does not silently swallow filesystem errors", () => temporary(async (directory) => {
    await writeFile(path.join(directory, "not-directory"), "existing data")
    await assert.rejects(loadConfig({ toolsDir: "not-directory" }, directory), { code: "ENOTDIR" })
  }))
  it("does not treat directories named *.txt as tools", () => temporary(async (directory) => {
    await mkdir(path.join(directory, "read.txt"))
    const config = await loadConfig({ toolsDir: directory, configDir: "absent" }, directory)
    assert.equal(config.tools.read, DEFAULT_TOOL_DESCRIPTIONS.read)
  }))
  it("rejects empty tool files", () => temporary(async (directory) => {
    await writeFile(path.join(directory, "read.txt"), " \n")
    await assert.rejects(loadConfig({ toolsDir: directory }, directory), /Empty tool description/)
  }))
  it("rejects empty prompt files", () => temporary(async (directory) => {
    await mkdir(path.join(directory, "prompt"))
    await writeFile(path.join(directory, "prompt", "default.txt"), "\n")
    await assert.rejects(loadConfig({ configDir: directory }, directory), /System prompt must not be empty/)
  }))
  for (const options of [null, [], { reset: true }, { unsupported: false }, { tools: [] },
    { tools: { read: 42 } }, { tools: { read: " " } }, { exclude: "read" }, { exclude: [42] },
    { configDir: false }, { toolsDir: "" }, { systemPrompt: "true" }]) {
    it(`rejects invalid options ${JSON.stringify(options)}`, () => temporary(async (directory) => {
      await assert.rejects(loadConfig(options, directory), TypeError)
      assert.deepEqual(await readdir(directory), [])
    }))
  }
})

describe("fail-closed system replacement", () => {
  it("recognizes every shipped stock template (including combined Anthropic)", async () => {
    const core = (await stock("core")).replace("${OPENCODE_TOOL_GUIDANCE}", "")
    for (const name of ["core", "gpt", "astra", "kimi", "trinity"]) {
      const text = (await stock(name)).replace("${OPENCODE_TOOL_GUIDANCE}", "")
      assert.ok(STOCK_PROMPT_HASHES.has(promptHash(text)), name)
    }
    assert.ok(STOCK_PROMPT_HASHES.has(promptHash(`${core}\n\n${(await stock("anthropic")).replace("${OPENCODE_TOOL_GUIDANCE}", "")}`)))
  })
  it("preserves all other parts, cache hints, instructions and their source metadata", async () => {
    const instructions = { type: "text", text: "AGENTS.md + date + environment + MCP", metadata: { experimental: { instructions: [{ key: "core/date", text: "today" }] } } }
    const system = [{ type: "text", text: (await stock("gpt")).replace("${OPENCODE_TOOL_GUIDANCE}", ""), cache: { type: "ephemeral" } }, instructions]
    assert.equal(replaceSystemPrompt(system, "Slim"), true)
    assert.equal(system[0].text, "Slim")
    assert.equal(system[0].cache.type, "ephemeral")
    assert.strictEqual(system[1], instructions)
  })
  it("never matches prompt markers embedded in custom or changed prompts", async () => {
    const template = (await stock("gpt")).replace("${OPENCODE_TOOL_GUIDANCE}", "")
    for (const text of ["You are opencode, an agent. Keep my instructions", `${template}\nSafety from another plugin`, `${template} `]) {
      const system = [{ type: "text", text }]
      assert.equal(replaceSystemPrompt(system, "Slim"), false)
      assert.equal(system[0].text, text)
    }
  })
  it("skips metadata-bearing first parts and absent parts", async () => {
    const system = [{ type: "text", text: (await stock("core")).replace("${OPENCODE_TOOL_GUIDANCE}", ""), metadata: {} }]
    assert.equal(replaceSystemPrompt(system, "Slim"), false)
    assert.equal(replaceSystemPrompt([], "Slim"), false)
  })
})

describe("real Plugin.define V2 entrypoint", () => {
  it("has a stable ID and setup, not a V1 function or hook object", () => {
    assert.equal(plugin.id, "opencode-slim-system")
    assert.equal(typeof plugin.setup, "function")
    assert.equal(typeof plugin, "object")
  })
  for (const kind of ["context", "generate", "compaction"]) {
    it(`registers and exercises ${kind} without touching schemas, history or options`, () => temporary(async (directory) => {
      const { hooks } = await setup({}, directory)
      assert.deepEqual([...hooks.keys()], ["context", "generate", "compaction"])
      const draft = event()
      const before = structuredClone(draft)
      const input = draft.tools.read.input
      await hooks.get(kind)(draft)
      assert.equal(draft.tools.read.description, DEFAULT_TOOL_DESCRIPTIONS.read)
      assert.strictEqual(draft.tools.read.input, input)
      assert.deepEqual(draft.tools.mcp_read, before.tools.mcp_read)
      assert.deepEqual(draft.tools.unknown, before.tools.unknown)
      assert.deepEqual(draft.system, before.system)
      assert.deepEqual(draft.messages, before.messages)
      assert.deepEqual(draft.options, before.options)
    }))
  }
  it("honors exclusions and explicit custom tool overrides", () => temporary(async (directory) => {
    const { hooks } = await setup({ exclude: ["read"], tools: { mcp_read: "Explicit MCP override" } }, directory)
    const draft = event()
    const originalRead = structuredClone(draft.tools.read)
    await hooks.get("context")(draft)
    assert.deepEqual(draft.tools.read, originalRead)
    assert.equal(draft.tools.mcp_read.description, "Explicit MCP override")
  }))
  it("does not mistake inherited object properties for configured tools", () => temporary(async (directory) => {
    const { hooks } = await setup({}, directory)
    const draft = event()
    draft.tools.toString = { description: "Unconfigured custom tool", input: {} }
    await hooks.get("context")(draft)
    assert.equal(draft.tools.toString.description, "Unconfigured custom tool")
  }))
  it("only replaces verified stock prompts when explicitly enabled", () => temporary(async (directory) => {
    const { hooks } = await setup({ systemPrompt: true }, directory)
    const draft = event([{ type: "text", text: (await stock("gpt")).replace("${OPENCODE_TOOL_GUIDANCE}", "") }])
    await hooks.get("context")(draft)
    assert.equal(draft.system[0].text, DEFAULT_SYSTEM_PROMPT)
  }))
  it("preserves custom agents even if their prompt exactly matches a stock prompt", () => temporary(async (directory) => {
    const template = (await stock("gpt")).replace("${OPENCODE_TOOL_GUIDANCE}", "")
    const { hooks } = await setup({ systemPrompt: true }, directory, { system: template })
    const draft = event([{ type: "text", text: template }])
    await hooks.get("generate")(draft)
    assert.equal(draft.system[0].text, template)
  }))
  it("reports actual last-request changes without triggering another model call", () => temporary(async (directory) => {
    const { hooks, commands, synthetics } = await setup({}, directory)
    const command = commands.get("slim-system-status")
    await command.execute({ sessionID: "session-test" })
    assert.equal(JSON.parse(synthetics[0].text).lastRequest, null)
    const draft = event()
    const original = structuredClone(draft)
    await hooks.get("context")(draft)
    await command.execute({ sessionID: "session-test" })
    const last = JSON.parse(synthetics[1].text).lastRequest
    assert.deepEqual(last.tools, ["read", "shell"])
    assert.equal(last.systemReplaced, false)
    assert.equal(last.charsSaved, original.tools.read.description.length + original.tools.shell.description.length - draft.tools.read.description.length - draft.tools.shell.description.length)
    assert.equal(last.estimatedTokensSaved, Math.round(last.charsSaved / 4))
    assert.equal(synthetics[0].resume, false)
    assert.equal(synthetics[1].resume, false)
  }))
  it("does not register timers, subscriptions, filesystem writes or a legacy TUI", async () => {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
    assert.equal(pkg.exports["./tui"], undefined)
    assert.equal(pkg.private, true)
    assert.equal(pkg.dependencies["@opencode/plugin"], "2.2.5")
    assert.equal(pkg.dependencies["@opencode-ai/plugin"], undefined)
  })
})
