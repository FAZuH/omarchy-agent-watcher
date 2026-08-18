// Agent Watcher bridge for OpenCode. `agent-watcher-setup install opencode`
// copies this file to ~/.config/opencode/plugins/agent-watcher.js with
// __HOOK_PATH__ replaced by the absolute path of bin/agent-watcher-hook.
// Runs inside the OpenCode process, so the hook's parent chain reaches the
// terminal window like every other agent's hooks.
import { spawn } from "node:child_process"

const HOOK = "__HOOK_PATH__"
const HOOK_TIMEOUT_MS = 5000

// Every send is a separate process, and OpenCode can emit two events that
// matter in the same millisecond -- a redundant "busy" status right before
// "session.idle". Run the hooks one at a time so the state file ends up
// holding the last event OpenCode actually reported, not whichever process
// happened to finish last.
let queue = Promise.resolve()

function send(event, sessionId, cwd, title) {
  queue = queue
    .then(
      () =>
        new Promise((resolve) => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve()
          }
          // A wedged hook must never stall every later event.
          const timer = setTimeout(finish, HOOK_TIMEOUT_MS)
          if (timer.unref) timer.unref()
          try {
            const child = spawn(HOOK, ["opencode", event], { stdio: ["pipe", "ignore", "ignore"] })
            child.on("error", finish)
            child.on("close", finish)
            child.stdin.on("error", () => {})
            child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: cwd, title: title || "" }))
          } catch (e) {
            finish() // never let a watcher failure surface inside the agent
          }
        }),
    )
    .catch(() => {})
  return queue
}

export const AgentWatcher = async ({ directory }) => {
  const dirs = new Map() // main session id -> its directory
  const titles = new Map() // main session id -> its current title
  const children = new Set() // sub-agent sessions (have parentID): ignored
  const busy = new Set() // sessions we have already reported as working
  const cwdOf = (id) => dirs.get(id) || directory
  const titleOf = (id) => titles.get(id) || ""
  return {
    event: async ({ event }) => {
      const p = (event && event.properties) || {}
      switch (event && event.type) {
        case "session.created":
          if (!p.info) break
          if (p.info.parentID) {
            children.add(p.info.id)
            break
          }
          dirs.set(p.info.id, p.info.directory || directory)
          titles.set(p.info.id, p.info.title || "")
          send("session-start", p.info.id, cwdOf(p.info.id), titleOf(p.info.id))
          break
        case "session.updated":
          // OpenCode names sessions after the first exchange ("New session"
          // becomes a summary); forward the new title without touching state.
          if (!p.info || children.has(p.info.id)) break
          if ((p.info.title || "") !== titleOf(p.info.id)) {
            titles.set(p.info.id, p.info.title || "")
            send("rename", p.info.id, cwdOf(p.info.id), titleOf(p.info.id))
          }
          break
        case "session.status":
          if (children.has(p.sessionID)) break
          if (p.status && p.status.type === "busy") {
            // Repeats carry no news, and re-sending "prompt" would drop a
            // pending permission back to plain working.
            if (busy.has(p.sessionID)) break
            busy.add(p.sessionID)
            send("prompt", p.sessionID, cwdOf(p.sessionID), titleOf(p.sessionID))
          } else {
            busy.delete(p.sessionID)
          }
          break
        case "permission.asked":
          if (!children.has(p.sessionID)) send("waiting", p.sessionID, cwdOf(p.sessionID), titleOf(p.sessionID))
          break
        case "permission.replied":
          if (!children.has(p.sessionID)) send("tool-done", p.sessionID, cwdOf(p.sessionID), titleOf(p.sessionID))
          break
        case "session.idle":
          busy.delete(p.sessionID)
          if (!children.has(p.sessionID)) send("done", p.sessionID, cwdOf(p.sessionID), titleOf(p.sessionID))
          break
        case "session.deleted":
          if (p.info && !children.has(p.info.id)) {
            send("session-end", p.info.id, cwdOf(p.info.id))
            dirs.delete(p.info.id)
            titles.delete(p.info.id)
            busy.delete(p.info.id)
          }
          break
        default:
          break
      }
    },
  }
}
