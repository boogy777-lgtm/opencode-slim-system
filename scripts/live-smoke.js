// Tests an npm-packed installation in a PRIVATE OpenCode service and local mock provider.
// No user config, credentials, sessions, shared service, or paid models are used.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_TOOL_DESCRIPTIONS } from "../src/defaults.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const binary = process.env.OPENCODE_BIN || "opencode"
const npm = process.env.npm_execpath
if (!npm) throw new Error("Run this test using npm run test:live")
const parent = process.platform === "win32" ? path.join(os.tmpdir(), "opencode") : os.tmpdir()
await mkdir(parent, { recursive: true })
const temp = await mkdtemp(path.join(parent, "slim-v2-live-"))
const workspace = path.join(temp, "workspace")
const configDir = path.join(temp, "config")
const requests = []
const mock = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests.push(body)
    const common = { id: `chatcmpl-${requests.length}`, created: 1, model: body.model }
    const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      for (const data of [
        { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "SMOKE_OK" }, finish_reason: null }] },
        { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ]) response.write(`data: ${JSON.stringify(data)}\n\n`)
      response.end("data: [DONE]\n\n")
    } else {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ ...common, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "SMOKE_OK" }, finish_reason: "stop" }], usage }))
    }
  } catch (error) {
    response.writeHead(500)
    response.end(String(error))
  }
})

let child
let success = false
let output = ""
try {
  const archive = JSON.parse(execFileSync(process.execPath, [npm, "pack", "--json", "--ignore-scripts", "--pack-destination", temp], { cwd: root, encoding: "utf8" }))[0].filename
  const install = path.join(temp, "installed")
  await mkdir(install)
  await writeFile(path.join(install, "package.json"), JSON.stringify({ private: true }))
  execFileSync(process.execPath, [npm, "install", "--prefix", install, path.join(temp, archive), "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: temp, stdio: "pipe" })
  const pluginPath = path.join(install, "node_modules", "opencode-slim-system")
  assert.ok((await readFile(path.join(pluginPath, "package.json"), "utf8")).includes('"private": true'))
  await Promise.all([mkdir(workspace), mkdir(configDir)])
  await writeFile(path.join(workspace, "AGENTS.md"), "SLIM_AGENT_INSTRUCTIONS_MUST_SURVIVE: preserve unrelated work.\n")
  mock.listen(0, "127.0.0.1")
  await once(mock, "listening")
  const model = { providerID: "slim-smoke", id: "gpt-slim-smoke" }
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "slim-smoke/gpt-slim-smoke",
    policies: [
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "slim-smoke", effect: "allow" },
    ],
    providers: {
      "slim-smoke": {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: "local-test-only", encoding: "none" },
        models: { "gpt-slim-smoke": { capabilities: { tools: true }, limit: { context: 128000, output: 4096 } } },
      },
    },
    compaction: { auto: false, keep: { tokens: 100 } },
    agents: { "slim-custom": { system: "CUSTOM_AGENT_SENTINEL: leave this custom prompt untouched.", model: "slim-smoke/gpt-slim-smoke" } },
    plugins: [{ package: pluginPath, options: { systemPrompt: true, configDir: path.join(temp, "slim-config") } }],
  }
  const configFile = path.join(workspace, "opencode.json")
  const save = () => writeFile(configFile, JSON.stringify(config, null, 2))
  await save()
  const env = {
    ...process.env,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_TEST_HOME: path.join(temp, "home"),
    OPENCODE_DB: path.join(temp, "data", "smoke.db"),
    XDG_CONFIG_HOME: path.join(temp, "xdg-config"),
    XDG_DATA_HOME: path.join(temp, "data"),
    XDG_STATE_HOME: path.join(temp, "state"),
    XDG_CACHE_HOME: path.join(temp, "cache"),
  }
  for (const key of ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_SERVER"]) delete env[key]
  const password = randomBytes(24).toString("hex")
  env.OPENCODE_PASSWORD = password
  child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] })
  const server = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Private service did not announce its URL\n${output}`)), 60000)
    const collect = (data) => {
      output += data.toString().replaceAll(password, "[redacted]")
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
      if (url) { clearTimeout(timer); resolve(url) }
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Private service exited ${code}\n${output}`)) })
  })
  const api = async (method, endpoint, body) => {
    const response = await fetch(`${server}${endpoint}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    })
    const text = await response.text()
    assert.ok(response.ok, `${method} ${endpoint}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  const query = `?${new URLSearchParams({ "location[directory]": workspace })}`
  const info = await api("GET", "/api/info")
  assert.equal(info.version, "2.2.5", "The live test targets the pinned SDK/runtime contract")
  const plugins = () => api("GET", `/api/plugin${query}`)
  const create = async (agent) => (await api("POST", "/api/session", { title: "Slim V2 isolated test", model, agent, location: { directory: workspace } })).data.id
  const wait = (id) => api("POST", `/api/experimental/session/${id}/wait`)
  const prompt = async (id, text) => {
    await api("POST", `/api/session/${id}/prompt`, { text })
    await wait(id)
  }
  const id = await create("build")
  await prompt(id, "Primary smoke test. No tools should be executed.\n" + "Sample project context for compaction. ".repeat(500))
  const primary = requests.at(-1)
  assert.ok(primary, "Primary request must reach the local mock")
  const inventory = await plugins()
  const active = inventory.data.find((entry) => entry.id === "opencode-slim-system")
  assert.equal(active?.state.status, "active", JSON.stringify(inventory))
  assert.equal(active.source.type, "local")
  assert.ok(active.source.path.startsWith(pluginPath), "Inventory source must refer to the tarball installation")
  const systemText = (request) => request.messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n")
  assert.ok(systemText(primary).includes(DEFAULT_SYSTEM_PROMPT), "Verified stock prompt should be replaced")
  assert.match(systemText(primary), /SLIM_AGENT_INSTRUCTIONS_MUST_SURVIVE/)
  assert.match(systemText(primary), /Working directory:/)
  const read = primary.tools.find((tool) => tool.function.name === "read").function
  assert.equal(read.description, DEFAULT_TOOL_DESCRIPTIONS.read)
  assert.ok(read.parameters.properties.path, "Native V2 tool schema must survive")

  const countBeforeGenerate = requests.length
  await api("POST", `/api/session/${id}/generate`, { prompt: "Transient generate smoke test" })
  assert.ok(requests.length > countBeforeGenerate)
  assert.ok(systemText(requests.at(-1)).includes(DEFAULT_SYSTEM_PROMPT), "generate hook should replace verified stock text")

  const countBeforeCompact = requests.length
  await api("POST", `/api/session/${id}/compact`, {})
  await wait(id)
  assert.ok(requests.length > countBeforeCompact, "Manual compaction must reach the mock")
  assert.ok(systemText(requests.at(-1)).includes(DEFAULT_SYSTEM_PROMPT), "compaction hook should replace verified stock text")

  const custom = await create("slim-custom")
  await prompt(custom, "Custom agent smoke test")
  assert.match(systemText(requests.at(-1)), /CUSTOM_AGENT_SENTINEL/)
  assert.equal(systemText(requests.at(-1)).includes(DEFAULT_SYSTEM_PROMPT), false)

  const requestsBeforeStatus = requests.length
  await api("POST", `/api/session/${id}/command`, { name: "slim-system-status", text: "" })
  assert.equal(requests.length, requestsBeforeStatus, "Status command must not invoke a model")
  const inbox = await api("GET", `/api/session/${id}/inbox`)
  assert.ok(JSON.stringify(inbox).includes('estimatedTokensSaved'))

  config.plugins = ["-opencode-slim-system"]
  await save()
  await api("POST", "/api/location/reload")
  const unloaded = await create("build")
  await prompt(unloaded, "Unloaded plugin smoke test")
  assert.notEqual(requests.at(-1).tools.find((tool) => tool.function.name === "read").function.description, DEFAULT_TOOL_DESCRIPTIONS.read)
  assert.equal(systemText(requests.at(-1)).includes(DEFAULT_SYSTEM_PROMPT), false)
  assert.equal((await plugins()).data.some((entry) => entry.id === "opencode-slim-system"), false)
  const commands = await api("GET", `/api/command${query}`)
  assert.equal(commands.data.some((command) => command.name === "slim-system-status"), false)

  config.plugins = [{ package: pluginPath, options: { tools: { read: "RELOADED_READ_DESCRIPTION" }, systemPrompt: false, configDir: path.join(temp, "slim-config") } }]
  await save()
  await api("POST", "/api/location/reload")
  const reloaded = await create("build")
  await prompt(reloaded, "Reloaded plugin smoke test")
  assert.equal((await plugins()).data.find((entry) => entry.id === "opencode-slim-system")?.state.status, "active")
  assert.equal(requests.at(-1).tools.find((tool) => tool.function.name === "read").function.description, "RELOADED_READ_DESCRIPTION")
  assert.equal(systemText(requests.at(-1)).includes(DEFAULT_SYSTEM_PROMPT), false)
  success = true
  console.log(JSON.stringify({
    runtime: info.version,
    installedPackage: "npm pack + isolated npm install --ignore-scripts",
    verified: ["active plugin ID/source", "context", "generate", "compaction", "custom-agent preservation", "AGENTS.md/environment preservation", "native tool schema", "status without model call", "unload removes command/hooks", "reload applies new options"],
    localMockRequests: requests.length,
    paidRequests: 0,
  }, null, 2))
} catch (error) {
  console.error(`Isolated test artifacts retained at ${temp}`)
  console.error(output)
  throw error
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit")
    child.kill()
    await exited
  }
  mock.closeAllConnections()
  await new Promise((resolve) => mock.close(resolve))
  if (success) await rm(temp, { recursive: true, force: true })
}
