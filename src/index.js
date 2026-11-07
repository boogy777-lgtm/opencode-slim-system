import { Plugin } from "@opencode/plugin"
import { loadConfig } from "./config.js"
import { replaceSystemPrompt } from "./system.js"

export default Plugin.define({
  id: "opencode-slim-system",
  async setup(ctx) {
    const config = await loadConfig(ctx.options, ctx.location.directory)
    /** @type {object | undefined} */
    let lastRequest

    /** @param {import("@opencode/plugin/promise/session").SessionContext} event */
    const slim = async (event) => {
      const changed = []
      let charsSaved = 0
      for (const [id, tool] of Object.entries(event.tools)) {
        if (config.exclude.has(id)) continue
        const description = config.tools[id]
        if (description === undefined || description === tool.description) continue
        charsSaved += tool.description.length - description.length
        tool.description = description
        changed.push(id)
      }

      let systemReplaced = false
      if (config.systemPrompt) {
        const agent = await ctx.agent.get({ agentID: event.agent })
        if (!agent.data.system) {
          const before = event.system[0]?.text.length ?? 0
          systemReplaced = replaceSystemPrompt(event.system, config.prompt)
          if (systemReplaced) charsSaved += before - event.system[0].text.length
        }
      }
      lastRequest = {
        sessionID: event.sessionID,
        tools: changed,
        systemReplaced,
        charsSaved,
        estimatedTokensSaved: Math.round(charsSaved / 4),
      }
    }

    // These hooks own outgoing drafts only: no durable prompt/history, schema or executor edits.
    await ctx.session.hook("context", slim)
    await ctx.session.hook("generate", slim)
    await ctx.session.hook("compaction", slim)
    await ctx.command.transform((editor) => {
      editor.add({
        name: "slim-system-status",
        description: "Report Slim System V2 configuration and the last outgoing request (no model call).",
        async execute({ sessionID }) {
          await ctx.session.synthetic({
            sessionID,
            resume: false,
            text: JSON.stringify({
              plugin: "opencode-slim-system",
              systemPrompt: config.systemPrompt,
              configuredTools: Object.keys(config.tools).filter((id) => !config.exclude.has(id)),
              lastRequest: lastRequest ?? null,
            }, null, 2),
          })
        },
      })
    })
  },
})
