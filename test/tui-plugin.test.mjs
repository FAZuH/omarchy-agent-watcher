import test from "node:test"
import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"

const { snapshot, transitions, selectedSessionId } = await import(
  pathToFileURL(new URL("../hooks/opencode-agent-watcher-tui.mjs", import.meta.url).pathname).href
)

// Fake TUI plugin ctx, shaped like opencode 2.0.3 (data.session.*, string
// statuses, permission/pending as list(sid) maps).
function fakeApi(session, extra = {}) {
  return {
    data: {
      session: {
        get: (id) => (session && session.id === id ? session : undefined),
        status: () => extra.status,
        permission: { list: () => extra.permissions || [] },
        pending: { list: () => extra.pending || [] },
        form: { list: () => extra.forms || [] },
      },
    },
  }
}

const sess = (over = {}) => ({ id: "s1", title: "fix the bar", location: { directory: "/proj" }, ...over })

// ---- selectedSessionId

test("selectedSessionId: runtime router shape, documented route shape, and none", () => {
  assert.equal(selectedSessionId({ ui: { router: { current: () => ({ type: "session", sessionID: "s1" }) } } }), "s1")
  assert.equal(selectedSessionId({ ui: { router: { current: () => ({ name: "session", params: { sessionID: "s2" } }) } } }), "s2")
  assert.equal(selectedSessionId({ ui: { router: { current: () => ({ type: "home" }) } } }), "")
  assert.equal(selectedSessionId({}), "")
})

// ---- snapshot

test("snapshot: status maps to the watcher states; permissions and pending win", () => {
  assert.equal(snapshot(fakeApi(sess(), { status: "running" }), "s1").state, "working")
  assert.equal(snapshot(fakeApi(sess(), { status: "retry" }), "s1").state, "working")
  assert.equal(snapshot(fakeApi(sess(), { status: "idle" }), "s1").state, "done")
  assert.equal(snapshot(fakeApi(sess(), { status: undefined }), "s1").state, "done")
  assert.equal(snapshot(fakeApi(sess(), { status: "running", permissions: [{ id: "p" }] }), "s1").state, "waiting")
  assert.equal(snapshot(fakeApi(sess(), { status: "running", pending: [{ id: "q" }] }), "s1").state, "waiting")
  assert.equal(snapshot(fakeApi(sess(), { status: "running", forms: [{ id: "frm" }] }), "s1").state, "waiting")
})

test("snapshot: multiline and padded titles collapse to one line", () => {
  const s = snapshot(fakeApi(sess({ title: " Omarchy: proj\nOmarchy: proj " }, { status: "idle" })), "s1")
  assert.equal(s.title, "Omarchy: proj Omarchy: proj")
})

test("snapshot: documented object statuses and function stores also work", () => {
  const ctx = {
    state: {
      session: {
        get: (id) => (id === "s1" ? { id, title: "t", directory: "/d" } : undefined),
        status: () => ({ type: "busy" }),
        permission: () => [],
      },
    },
  }
  const s = snapshot(ctx, "s1")
  assert.equal(s.state, "working")
  assert.equal(s.cwd, "/d")
})

test("snapshot: a pending permission or question on a subagent child makes the parent waiting", () => {
  const childCtx = (key) => ({
    data: {
      session: {
        get: (id) => (id === "s1" ? sess() : id === "c1" ? { id: "c1", parentID: "s1" } : undefined),
        status: () => "running",
        permission: { list: (id) => (id === "c1" && key === "permission" ? [{ id: "p" }] : []) },
        pending: { list: (id) => (id === "c1" && key === "pending" ? [{ id: "q" }] : []) },
      },
    },
  })
  assert.equal(snapshot(childCtx("permission"), "s1", ["c1"]).state, "waiting")
  assert.equal(snapshot(childCtx("pending"), "s1", ["c1"]).state, "waiting")
  assert.equal(snapshot(childCtx("permission"), "s1").state, "working")
  assert.equal(snapshot(childCtx("permission"), "s1", []).state, "working")
})

test("snapshot: carries id, cwd and title; child and unknown sessions are untracked", () => {
  const s = snapshot(fakeApi(sess(), { status: "idle" }), "s1")
  assert.deepEqual({ sessionId: s.sessionId, cwd: s.cwd, title: s.title }, { sessionId: "s1", cwd: "/proj", title: "fix the bar" })
  assert.equal(snapshot(fakeApi(sess({ parentID: "root" })), "s1"), null)
  assert.equal(snapshot(fakeApi(sess()), "other"), null)
})

// ---- transitions

const snap = (state, title = "t") => ({ sessionId: "s1", cwd: "/proj", title, state })

test("transitions: a new session starts, and never blinks done at creation", () => {
  // Idle sessions are never announced by the watcher, so a null-prev "done"
  // only happens on an ownership flip of a row that already exists.
  assert.deepEqual(transitions(null, snap("done")), ["done"])
  assert.deepEqual(transitions(null, snap("working")), ["session-start", "prompt"])
  assert.deepEqual(transitions(null, snap("waiting")), ["session-start", "waiting"])
  assert.deepEqual(transitions(null, null), [])
})

test("transitions: a vanished session ends", () => {
  assert.deepEqual(transitions(snap("working"), null), ["session-end"])
})

test("transitions: state moves map to the hook events the bar understands", () => {
  assert.deepEqual(transitions(snap("working"), snap("waiting")), ["waiting"])
  assert.deepEqual(transitions(snap("waiting"), snap("working")), ["tool-done"])
  assert.deepEqual(transitions(snap("working"), snap("done")), ["done"])
  assert.deepEqual(transitions(snap("done"), snap("working")), ["prompt"])
  assert.deepEqual(transitions(snap("waiting"), snap("done")), ["done"])
  assert.deepEqual(transitions(snap("done"), snap("waiting")), ["waiting"])
})

test("transitions: steady states send nothing; titles only rename when nothing else moved", () => {
  assert.deepEqual(transitions(snap("working", "a"), snap("working", "a")), [])
  assert.deepEqual(transitions(snap("working", "a"), snap("working", "b")), ["rename"])
  // A state event carries the new title already -- no second send.
  assert.deepEqual(transitions(snap("working", "a"), snap("done", "b")), ["done"])
})
