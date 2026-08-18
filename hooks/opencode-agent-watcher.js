// Agent Watcher bridge for OpenCode. `agent-watcher-setup install opencode`
// copies this file to ~/.config/opencode/plugins/agent-watcher.js with
// __HOOK_PATH__ replaced by the absolute path of bin/agent-watcher-hook.
// Runs inside the OpenCode process, so the hook's parent chain reaches the
// terminal window like every other agent's hooks.
import { spawn } from "node:child_process"

const HOOK = "__HOOK_PATH__"

function send(event, sessionId, cwd) {
  try {
    const child = spawn(HOOK, ["opencode", event], { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => {})
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: cwd }))
  } catch (e) {
    // never let a watcher failure surface inside the agent
  }
}

export const AgentWatcher = async ({ directory }) => {
  const dirs = new Map()      // main session id -> its directory
  const children = new Set()  // sub-agent sessions (have parentID): ignored
  const cwdOf = (id) => dirs.get(id) || directory
  return {
    event: async ({ event }) => {
      const p = (event && event.properties) || {}
      switch (event && event.type) {
        case "session.created":
          if (!p.info) break
          if (p.info.parentID) { children.add(p.info.id); break }
          dirs.set(p.info.id, p.info.directory || directory)
          send("session-start", p.info.id, cwdOf(p.info.id))
          break
        case "session.status":
          if (children.has(p.sessionID)) break
          if (p.status && p.status.type === "busy") send("prompt", p.sessionID, cwdOf(p.sessionID))
          break
        case "permission.asked":
          if (!children.has(p.sessionID)) send("waiting", p.sessionID, cwdOf(p.sessionID))
          break
        case "permission.replied":
          if (!children.has(p.sessionID)) send("tool-done", p.sessionID, cwdOf(p.sessionID))
          break
        case "session.idle":
          if (!children.has(p.sessionID)) send("done", p.sessionID, cwdOf(p.sessionID))
          break
        case "session.deleted":
          if (p.info && !children.has(p.info.id)) { send("session-end", p.info.id, cwdOf(p.info.id)); dirs.delete(p.info.id) }
          break
        default:
          break
      }
    }
  }
}
