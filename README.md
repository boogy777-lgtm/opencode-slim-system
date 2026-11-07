# opencode-slim-system — OpenCode V2 port

Compact tool descriptions for **OpenCode 2.2.5**, with optional, fail-closed replacement of verified stock system prompts.

Public fork of [SK-DEV-AI/opencode-slim-system](https://github.com/SK-DEV-AI/opencode-slim-system).
The original Git history, author attribution and [MIT license](LICENSE) are retained. This fork's version is
`3.0.0-v2.0`; it is **not** the upstream npm release. No npm package has been published by this fork, and
`private: true` plus a test-only workflow prevent accidental npm publication.

## Install

Use OpenCode **V2**, not V1. Prefer an exact commit when installing from GitHub:

```sh
opencode plugin add github:boogy777-lgtm/opencode-slim-system#master
```

`master` tracks this fork; replace it with a full commit hash to pin an audited revision. Do **not** install the
unscoped npm name `opencode-slim-system`: that belongs to the upstream V1 plugin.

Alternatively, clone to a **new, empty destination**, install dependencies and configure the **directory**:

```sh
git clone https://github.com/boogy777-lgtm/opencode-slim-system.git
cd opencode-slim-system
npm ci --ignore-scripts
```

Append an entry to your existing global `~/.config/opencode/opencode.json(c)` `plugins` array; preserve the other entries
and settings. A project-level `opencode.json(c)` limits the plugin to that project.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-slim-system",
      "options": {
        "exclude": ["websearch"],
        "systemPrompt": false
      }
    }
  ]
}
```

On Windows use a directory such as `C:/Users/you/code/opencode-slim-system`. File paths such as `src/index.js` are **not**
valid configured plugin targets in V2. Keep a locally linked clone and its `node_modules` in place.

OpenCode watches configuration and reloads plugins. No shared-service restart is required for installation. Verify the
active plugin ID and source with the plugin inventory (`GET /api/plugin`, using the relevant Location); a configured entry
alone does not prove successful activation. Startup inventory may be empty before that Location's plugins have activated.

## What the V2 port actually does

The entrypoint default-exports `Plugin.define({ id: "opencode-slim-system", setup(ctx) })` from `@opencode/plugin@2.2.5`.
It registers the public V2 session hooks **`context`**, **`generate`**, and **`compaction`**, plus one command transform.
There are no V1 hook keys or V1 SDK dependencies.

- Changes only `description` on matching tools in the **outgoing request draft**. Schemas, names, executors, permissions,
  history and model options are unchanged. This is request-scoped slimming, not a global tool-registry transform.
- Ships 13 V2 descriptions: `edit`, `glob`, `grep`, `patch`, `question`, `read`, `shell`, `skill`, `subagent`,
  `todowrite`, `webfetch`, `websearch`, `write`. Only tools present in a particular request are changed.
- Leaves unknown tools, MCP tools and other plugins' tools alone unless you explicitly supply their exact effective ID
  through a file or inline override. A plugin overriding a built-in's ID shares that ID and is not distinguishable here.
- Leaves the system prompt untouched by default. Set **`systemPrompt: true`** to opt in to replacing the first part
  **only when its SHA-256 exactly matches a checked stock OpenCode 2.2.5 snapshot** and the active agent has no custom system
  prompt. Subsequent system parts, including `AGENTS.md`, environment, date and instruction-source metadata, remain intact.
- Does not touch title requests. No prompt-admission hook is registered, so canonical user messages are never rewritten.

The stock allowlist covers the fallback, GPT, GPT Astra, Kimi, Trinity and combined Anthropic templates from
[OpenCode v2.2.5](https://github.com/anomalyco/opencode/tree/v2.2.5), including its shell/edit/write guidance combinations.
Unknown prompt texts, dynamic Meta templates, additional text from another plugin, and metadata-bearing first parts are
left unchanged. There is deliberately **no marker-substring fallback**. Shortening instructions can still change model
behavior; evaluate on your own tasks before enabling system-prompt replacement globally.

## Options and customization

The optional customization directory is `$XDG_CONFIG_HOME/opencode/slim-system-v2`, or
`~/.config/opencode/slim-system-v2` when XDG is unset. It is separate from V1's `slim-system` directory.

| Option | Default | Behavior |
| --- | --- | --- |
| `exclude` | `[]` | Exact, case-sensitive tool IDs to leave unchanged; wins over overrides. |
| `tools` | `{}` | Inline `id: description` overrides; custom/MCP IDs require explicit opt-in here or in files. |
| `configDir` | V2 directory above | Base for `tool/*.txt` and `prompt/default.txt`. |
| `toolsDir` | `<configDir>/tool` | A custom directory of `{effectiveToolID}.txt` descriptions. |
| `systemPrompt` | `false` | Opt in to verified stock system-prompt replacement. |

Path options resolve relative to the plugin's OpenCode Location, not the config file. `~/` and `~\` expand to the user's
home directory. Precedence: **exclude → inline tools → toolsDir files → embedded V2 defaults → unchanged**.
`{{year}}` is resolved in all descriptions and the optional prompt. No other placeholders are supported.

Create only the override files you need. Nothing is automatically seeded, overwritten, reset or deleted. Missing files
fall back to embedded defaults; empty files, invalid options and filesystem errors other than missing paths fail setup
with a diagnostic instead of being silently ignored. Options are described in [schema.json](schema.json).

Files are read once during plugin setup, not watched independently. After editing an override, reload configuration
with `/reload` (which also reloads other plugins); there is no need to restart the shared service.

### Diagnostics

`/slim-system-status` queues a synthetic status item with `resume: false`: it does **not** start a model request. It can be
inspected in the session's pending inbox (`GET /api/session/{sessionID}/inbox`) and is delivered with the next turn.
It reports configured IDs separately from the tools actually changed in the **last request at this Location** (which
may belong to another session), whether that request's system prompt was replaced, and its character delta.

`estimatedTokensSaved = round(charsSaved / 4)` is only a rough character-based estimate and can be negative for longer
custom descriptions. There is no fixed V1 token baseline, claim of guaranteed savings, global `/tmp` status file,
telemetry, update check, timer or persistent plugin state.

## Migrating from the upstream V1 plugin

1. Back up existing config. Replace only the old plugin's config entry; preserve unrelated plugins/settings.
2. Use V2 `plugins: [{ "package": "<directory-or-Git-target>", "options": { ... } }]`, not V1 `plugin` tuples or file targets.
3. Review overrides before copying to `slim-system-v2`: `bash` → `shell`, `task` → `subagent`, `apply_patch` → `patch`;
   their argument names also changed (`path`, `sessionID`, etc.). Do not blindly rename old descriptions.
4. V1 `lsp` and `plan_exit` templates are not loaded. V2 has no LSP runtime; model/agent/feature settings determine which
   of the supported tools appear. `todowrite` requires `experimental.todo`.
5. `reset` is intentionally rejected; this plugin never recursively deletes your customization directory.
6. The V1 TUI sidebar is **not shipped in this port**. There is no `./tui` export and no need to edit `cli.json` or
   `tui.json`. Use the status command instead. Per-model filename selection, export/import CLIs, npm update notifications
   and drift-check commands previously advertised by upstream are not implemented here.

V1 implementation entrypoints are not supported. For V2 API background, see the official
[migration guide](https://opencode.ai/v2/docs/migrate-v1),
[plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1) and
[server plugin reference](https://opencode.ai/v2/docs/build/plugins/server).

## Development and verification

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run --ignore-scripts
```

`check` regenerates `src/defaults.js`, typechecks the JavaScript against the **real V2 SDK**, and runs offline unit tests
covering all registered hooks, exclusions/overrides, defaults completeness, non-destructive I/O, invalid options,
status output and preservation of schemas/history/custom prompts. CI checks Node 22/24 on Linux and Windows and
ensures generated defaults are committed. The CI workflow does not publish anything.

For an installed-package test with an **OpenCode 2.2.5 CLI**:

```sh
OPENCODE_BIN=/path/to/opencode npm run test:live
```

```powershell
$env:OPENCODE_BIN = 'C:/path/to/opencode-cli.exe'
npm run test:live
```

The script runs `npm pack` and an isolated tarball installation, starts a **private authenticated** OpenCode server and
local mock provider, verifies real `context`/`generate`/`compaction` requests, preservation of `AGENTS.md`/environment/custom
agents/native tool schemas, no model call for status, and actual unload/reload behavior. It never modifies your shared
service or user config, and makes **zero paid model requests**. Successful runs remove their own temporary directory;
failed runs retain isolated artifacts for inspection. This proves integration, **not** real-model quality or tokenizer savings.

`scripts/gen-stock-prompts.js` is an explicit, network-using maintainer operation pinned to the upstream 2.2.5 commit.
The plugin itself never downloads prompts. Original stock test fixtures include their upstream MIT license.

### Known dependency limitation

The pinned OpenCode SDK pulls in npm tooling dependencies. At verification time, `npm audit --omit=dev` reported
**24 moderate transitive findings** involving `glob`/`minimatch`, with no fix offered; no high/critical findings were reported.
They are not silently suppressed or force-upgraded outside the tested SDK contract. Recheck the lockfile when upgrading
OpenCode. V2 releases other than 2.2.5 and live paid-provider behavior are not verified.

## License

MIT. Original plugin copyright remains in [LICENSE](LICENSE); OpenCode stock fixture licensing is in
[tests/fixtures/stock/LICENSE](tests/fixtures/stock/LICENSE).
