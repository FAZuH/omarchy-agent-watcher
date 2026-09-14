import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar entry for Agent Watcher: robot icon + working/attention counts that
// blink while a session finished or waits for you in a window you are not
// looking at. Owns all session state (Panel.qml only renders it), the IPC
// target, the dump/prune process and the focus watcher. Panel plumbing
// follows omarchy-stocks / omarchy.weather.
BarWidget {
  id: root
  moduleName: "io.github.5d0tal1gat0r.agent-watcher"

  // ---- Settings (inline on this widget's shell.json entry).
  readonly property bool blinkOnDone: Model.boolSetting(setting("blinkOnDone", true), true)
  readonly property bool blinkOnWaiting: Model.boolSetting(setting("blinkOnWaiting", true), true)
  readonly property var blinkSettings: ({ blinkOnDone: blinkOnDone, blinkOnWaiting: blinkOnWaiting })

  // ---- Session state: key -> session (Model.normalizeSession + seen/stateSince).
  property var sessions: ({})
  readonly property var sessionList: Model.sessionList(sessions)
  readonly property var summary: Model.barSummary(sessionList, blinkSettings)
  readonly property var parts: Model.barParts(summary)
  readonly property string hookScript: Model.pathFromUrl(Qt.resolvedUrl("bin/agent-watcher-hook"))
  readonly property string setupScript: Model.pathFromUrl(Qt.resolvedUrl("bin/agent-watcher-setup"))
  property bool dumpPending: false

  // ---- Colors: theme palette (colors.toml) with fallbacks.
  property string themeGreen: ""
  property string themeYellow: ""
  readonly property color doneColor: themeGreen !== "" ? themeGreen : "#5fbf6f"
  readonly property color waitingColor: themeYellow !== "" ? themeYellow : "#d8a657"
  readonly property color attentionColor: summary.level === "waiting" ? waitingColor : doneColor

  // ---- Blink: opacity pulse on the icon and the attention count.
  property real pulse: 1
  SequentialAnimation on pulse {
    running: root.summary.blink
    loops: Animation.Infinite
    NumberAnimation { to: 0.3; duration: 500; easing.type: Easing.InOutSine }
    NumberAnimation { to: 1.0; duration: 500; easing.type: Easing.InOutSine }
    onStopped: root.pulse = 1
  }

  function activeAddress() {
    var t = Hyprland.activeToplevel
    return t ? Model.normalizeAddress(t.address) : ""
  }

  function requestDump() {
    Hyprland.refreshToplevels()
    if (dumpProc.running) { dumpPending = true; return }
    dumpProc.running = true
  }

  function applySnapshot(text) {
    // A dump that is not a JSON array means the dump failed, not that every
    // session ended: keeping the old map avoids resurrecting acknowledged
    // "done" sessions as unseen (blinking) on the next successful dump.
    var res = Model.parseSnapshotResult(text)
    if (!res.ok) return
    var now = Math.floor(Date.now() / 1000)
    sessions = Model.mergeSessions(sessions, res.sessions, activeAddress(), now)
  }

  function acknowledgeFocused() {
    var addr = activeAddress()
    if (addr === "") return
    sessions = Model.markSeen(sessions, addr)
  }

  // ---- Right-click dismiss of a done session: drop the row now and delete
  // its state file through the hook. If the session works again the agent
  // reports it and a fresh row appears.
  property var dismissQueue: []

  function dismissSession(session) {
    if (!session || session.state !== "done") return
    sessions = Model.removeSession(sessions, session.key)
    dismissQueue = dismissQueue.concat([session])
    pumpDismiss()
  }

  function pumpDismiss() {
    if (dismissProc.running || dismissQueue.length === 0) return
    var s = dismissQueue[0]
    dismissQueue = dismissQueue.slice(1)
    // The hook reads its JSON event on stdin: printf feeds it and closes the
    // pipe, positional "$0"/"$1" keep the payload and paths quoting-safe.
    dismissProc.command = ["sh", "-c",
      'printf %s "$0" | exec "$1" "$2" session-end',
      JSON.stringify({ session_id: s.sessionId }), hookScript, s.agent]
    dismissProc.running = true
  }

  function focusSession(session) {
    if (!session || session.windowAddress === "") return
    var target = "address:0x" + session.windowAddress
    // Hyprland >= 0.56 (Lua dispatch API) and the classic form for older builds;
    // whichever the compositor rejects is a harmless no-op.
    Hyprland.dispatch('hl.dsp.focus{window="' + target + '"}')
    Hyprland.dispatch("focuswindow " + target)
  }

  // ---- Panel plumbing (open/close/opened contract for shell.summon|hide|toggle).
  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("host" in target) target.host = root
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.open) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()
  Component.onCompleted: Qt.callLater(root.requestDump)

  // One piece of the pill overlay (inline components must live at the root).
  component Piece: Text {
    font.family: button.fontFamily
    font.pixelSize: button.fontSize
    renderType: Text.NativeRendering
    color: button.foreground
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "io.github.5d0tal1gat0r.agent-watcher"

    function refresh(): void { root.broadcast("requestDump") }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
  }

  Connections {
    target: Hyprland
    function onActiveToplevelChanged() { root.acknowledgeFocused() }
  }

  // A window came or went (a terminal was closed): re-check right away so an
  // agent that outlived its terminal disappears within a second, not at the
  // next 15 s prune. Debounced: closing a window fires several model updates.
  Connections {
    target: Hyprland.toplevels
    function onValuesChanged() { windowChangeDebounce.restart() }
  }

  Timer {
    id: windowChangeDebounce
    interval: 700
    repeat: false
    onTriggered: root.requestDump()
  }

  Process {
    id: dumpProc
    command: [root.hookScript, "dump"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.applySnapshot(text)
        if (root.dumpPending) {
          root.dumpPending = false
          Qt.callLater(root.requestDump)
        }
      }
    }
  }

  Process {
    id: dismissProc
    running: false
    onExited: root.pumpDismiss()
  }

  // Liveness: prune dead agents even when no hook ever fires again.
  Timer {
    interval: 15000
    running: true
    repeat: true
    onTriggered: root.requestDump()
  }

  FileView {
    path: Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      root.themeGreen = Model.parseThemeColor(text(), "green")
      root.themeYellow = Model.parseThemeColor(text(), "yellow")
    }
    onLoadFailed: {
      root.themeGreen = ""
      root.themeYellow = ""
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // The (hidden) label sizes the pill and is what vertical bars show; the
    // colored overlay below is the horizontal rendering.
    text: root.vertical ? Model.verticalLabel(root.summary) : Model.barLabel(root.summary)
    labelVisible: root.vertical
    hasVisualContent: true
    dimmed: root.summary.total === 0
    foreground: root.vertical && root.summary.blink ? root.attentionColor : (root.bar ? root.bar.barForeground : Color.foreground)
    tooltipText: ""

    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.requestDump()
      else root.togglePanel()
    }

    Row {
      visible: !root.vertical
      anchors.centerIn: parent
      spacing: 0

      Piece {
        text: root.parts.icon
        color: root.summary.blink ? root.attentionColor : button.foreground
        opacity: root.pulse
      }
      Piece { text: root.parts.working }
      Piece {
        text: root.parts.dot
        color: Qt.darker(button.foreground, 1.6)
      }
      Piece {
        text: root.parts.attention
        color: root.attentionColor
        opacity: root.pulse
      }
    }
  }
}
