import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Popup for Agent Watcher: sessions grouped by workspace, click-to-focus, and
// per-agent hook setup. All session state lives on `host` (BarWidget.qml).
Panel {
  id: root
  moduleName: "io.github.5d0tal1gat0r.agent-watcher"
  // The bar entry (BarWidget.qml) owns the IPC target; see its IpcHandler.
  manageIpc: false

  property var anchorItem: null
  // The bar identifies a panel by the widget mounted in its slot, not by this
  // nested item, so popout switching and the open-panel indicator use it.
  property var hostWidget: null
  property var host: null
  readonly property var barIdentity: hostWidget || root

  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color mutedForeground: Qt.darker(barForeground, 1.5)
  readonly property color doneColor: host ? host.doneColor : "#5fbf6f"
  readonly property color waitingColor: host ? host.waitingColor : "#d8a657"
  readonly property var blinkSettings: host ? host.blinkSettings : ({})
  readonly property var sessionList: host ? host.sessionList : []
  readonly property var summary: host ? host.summary : Model.barSummary([], {})

  // Re-evaluated every second while open (elapsed times, workspace moves).
  property int nowSec: Math.floor(Date.now() / 1000)
  property int tick: 0

  Timer {
    interval: 1000
    running: root.opened
    repeat: true
    triggeredOnStart: true
    onTriggered: {
      root.nowSec = Math.floor(Date.now() / 1000)
      root.tick++
      root.refreshLookup()
      root.refreshGroups()
    }
  }

  // address -> { workspaceId, title } from the live toplevels. Reassigned
  // (a new object reference) only when the content actually changed, so the
  // Repeaters below don't tear down/rebuild every delegate (and flicker the
  // hover highlight under a still pointer) on every 1 s tick.
  property var lookup: ({})
  property string lookupKey: ""

  function refreshLookup() {
    var out = {}
    var values = Hyprland.toplevels.values
    for (var i = 0; i < values.length; i++) {
      var tl = values[i]
      var addr = Model.normalizeAddress(tl.address)
      if (addr === "") continue
      out[addr] = { workspaceId: tl.workspace ? tl.workspace.id : -1, title: tl.title || "" }
    }
    var key = JSON.stringify(out)
    if (key !== root.lookupKey) {
      root.lookupKey = key
      root.lookup = out
    }
  }

  readonly property int focusedWorkspaceId: {
    if (Hyprland.focusedWorkspace) return Hyprland.focusedWorkspace.id
    if (Hyprland.focusedMonitor && Hyprland.focusedMonitor.activeWorkspace) return Hyprland.focusedMonitor.activeWorkspace.id
    return -1
  }

  property var groups: []
  property string groupsKey: ""

  function refreshGroups() {
    var g = Model.groupByWorkspace(sessionList, lookup, focusedWorkspaceId, blinkSettings)
    var key = JSON.stringify(g)
    if (key !== root.groupsKey) {
      root.groupsKey = key
      root.groups = g
    }
  }

  // Recompute both derived collections; called on open, on the 1 s tick
  // while open, and whenever their real inputs change.
  function refreshDerived() {
    root.refreshLookup()
    root.refreshGroups()
  }

  onSessionListChanged: root.refreshDerived()
  onFocusedWorkspaceIdChanged: root.refreshDerived()
  onBlinkSettingsChanged: root.refreshDerived()

  // ---- Hook setup state.
  property var hookStatus: ({})
  property string busyAgent: ""
  // Last failed install/remove: shown on that agent's row until it is retried.
  property string setupFailedAgent: ""
  property string setupFailedText: ""
  readonly property bool anyHooksInstalled: {
    for (var k in hookStatus) if (hookStatus[k] === "installed") return true
    return false
  }

  function stateColor(session) {
    var ds = Model.displayState(session)
    if (ds === "waiting") return root.waitingColor
    if (ds === "done") return root.doneColor
    if (ds === "working") return root.barForeground
    return root.mutedForeground
  }

  function titleFor(session) {
    var win = session.windowAddress !== "" ? root.lookup[session.windowAddress] : null
    var title = win ? Model.cleanTitle(win.title) : ""
    return title !== "" ? title : session.cwd
  }

  function focusRow(session) {
    if (root.host) root.host.focusSession(session)
    root.close()
  }

  function refreshHookStatus() {
    if (!root.host || statusProc.running) return
    statusProc.command = [root.host.setupScript, "status", "all"]
    statusProc.running = true
  }

  function runSetup(action, agent) {
    if (!root.host || setupProc.running) return
    root.busyAgent = agent
    root.setupFailedAgent = ""
    root.setupFailedText = ""
    setupProc.lastError = ""
    setupProc.command = [root.host.setupScript, action, agent]
    setupProc.running = true
  }

  function open() {
    // Timer.triggeredOnStart lands a tick late; set these immediately so the
    // first paint after summon never shows a stale (potentially hours-off)
    // elapsed time.
    root.nowSec = Math.floor(Date.now() / 1000)
    root.tick++
    root.refreshDerived()
    root.controller.show()
    refreshHookStatus()
    if (root.host) root.host.requestDump()
  }

  function close() {
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) close()
    else open()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  Process {
    id: statusProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.hookStatus = Model.parseHookStatus(text)
    }
  }

  Process {
    id: setupProc
    property string lastError: ""
    // The setup script refuses to touch a config it cannot parse and explains
    // why on stderr; without this the chip would just flip back to Install.
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: setupProc.lastError = String(text || "").split("\n")[0]
    }
    onExited: function(code, status) {
      if (code !== 0) {
        root.setupFailedAgent = root.busyAgent
        root.setupFailedText = setupProc.lastError !== "" ? setupProc.lastError : "failed"
      }
      root.busyAgent = ""
      root.refreshHookStatus()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(440))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onReturnRequested: if (root.host) root.host.requestDump()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(8)

        // ---- Header: title + summary.
        Item {
          width: parent.width
          height: headerTitle.implicitHeight

          Text {
            id: headerTitle
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: "Agent sessions"
            color: root.barForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.subtitle
            font.bold: true
          }

          Text {
            anchors.right: parent.right
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: Model.summaryLine(root.summary)
            color: root.mutedForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        PanelSeparator { foreground: root.barForeground }

        // ---- Empty state.
        Text {
          visible: root.sessionList.length === 0
          width: parent.width
          leftPadding: Style.space(8)
          rightPadding: Style.space(8)
          wrapMode: Text.WordWrap
          text: root.anyHooksInstalled
            ? "No sessions yet — start an agent in a terminal."
            : "Install hooks below to start tracking."
          color: root.mutedForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          font.italic: true
        }

        // ---- One block per workspace.
        Repeater {
          model: root.groups

          Column {
            id: group
            required property var modelData
            width: content.width
            spacing: 0

            Item {
              width: parent.width
              height: groupLabel.implicitHeight + Style.space(6)

              Text {
                id: groupLabel
                anchors.left: parent.left
                anchors.leftMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                text: group.modelData.label + (group.modelData.current ? "  · current" : "")
                color: root.mutedForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }
            }

            Repeater {
              model: group.modelData.sessions

              Rectangle {
                id: row
                required property var modelData
                readonly property bool attention: Model.needsAttention(modelData, root.blinkSettings)
                readonly property bool focusable: modelData.windowAddress !== ""
                width: content.width
                height: line1.implicitHeight + line2.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: rowMouse.containsMouse && row.focusable
                  ? Style.hoverFillFor(root.barForeground, Color.accent)
                  : (row.attention ? Style.selectedFillFor(root.barForeground, Color.accent) : "transparent")

                Rectangle {
                  id: dot
                  anchors.left: parent.left
                  anchors.leftMargin: Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  width: Style.space(8)
                  height: width
                  radius: width / 2
                  color: root.stateColor(row.modelData)
                }

                Row {
                  id: line1
                  anchors.left: dot.right
                  anchors.leftMargin: Style.space(8)
                  anchors.right: elapsed.left
                  anchors.rightMargin: Style.space(8)
                  anchors.top: parent.top
                  anchors.topMargin: Style.space(6)
                  spacing: Style.space(6)

                  Rectangle {
                    id: agentChip
                    anchors.verticalCenter: parent.verticalCenter
                    width: agentTag.implicitWidth + Style.space(8)
                    height: agentTag.implicitHeight + Style.space(2)
                    radius: Style.cornerRadius
                    color: Style.selectedFillFor(root.barForeground, Color.accent)

                    Text {
                      id: agentTag
                      anchors.centerIn: parent
                      text: row.modelData.agent
                      color: root.mutedForeground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    // Bounded so ElideRight actually engages instead of
                    // overflowing under the elapsed label for long basenames.
                    width: Math.min(implicitWidth, Math.max(0, line1.width - agentChip.width - stateText.implicitWidth - line1.spacing * 2))
                    text: Model.projectName(row.modelData.cwd)
                    color: root.barForeground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: true
                    elide: Text.ElideRight
                  }

                  Text {
                    id: stateText
                    anchors.verticalCenter: parent.verticalCenter
                    text: Model.displayState(row.modelData)
                    color: root.stateColor(row.modelData)
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: row.attention
                  }
                }

                Text {
                  id: elapsed
                  anchors.right: parent.right
                  anchors.rightMargin: Style.space(8)
                  anchors.verticalCenter: line1.verticalCenter
                  text: Model.formatElapsed(row.modelData.stateSince, root.nowSec)
                  color: root.mutedForeground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                Text {
                  id: line2
                  anchors.left: line1.left
                  anchors.right: parent.right
                  anchors.rightMargin: Style.space(8)
                  anchors.top: line1.bottom
                  anchors.topMargin: Style.space(2)
                  text: root.titleFor(row.modelData)
                  color: root.mutedForeground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideMiddle
                }

                MouseArea {
                  id: rowMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: row.focusable ? Qt.PointingHandCursor : Qt.ArrowCursor
                  onClicked: if (row.focusable) root.focusRow(row.modelData)
                }
              }
            }
          }
        }

        PanelSeparator { foreground: root.barForeground }

        // ---- Hooks: one line per agent with Install / Remove.
        Text {
          leftPadding: Style.space(8)
          text: "Hooks"
          color: root.mutedForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
        }

        Repeater {
          model: Model.AGENTS

          Item {
            id: hookRow
            required property var modelData
            readonly property string status: root.hookStatus[modelData.id] || ""
            readonly property bool installed: status === "installed"
            readonly property bool missing: status === "agent-missing"
            readonly property bool busy: root.busyAgent === modelData.id
            readonly property bool failed: root.setupFailedAgent === modelData.id
            width: content.width
            height: hookName.implicitHeight + Style.space(10)

            Text {
              id: hookName
              anchors.left: parent.left
              anchors.leftMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              text: hookRow.modelData.name
              color: hookRow.missing ? root.mutedForeground : root.barForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              anchors.left: hookName.right
              anchors.leftMargin: Style.space(10)
              // Stop short of the chip: the Codex note is long enough to run
              // underneath it otherwise.
              anchors.right: actionChip.left
              anchors.rightMargin: Style.space(10)
              anchors.verticalCenter: parent.verticalCenter
              elide: Text.ElideRight
              text: hookRow.failed ? root.setupFailedText
                : (hookRow.busy ? "working…" : Model.hookStatusLabel(hookRow.status))
                  + (hookRow.installed && hookRow.modelData.id === "codex" ? "  (run /hooks in Codex once to trust)" : "")
              color: hookRow.failed ? root.waitingColor
                : (hookRow.installed ? root.doneColor : root.mutedForeground)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Rectangle {
              id: actionChip
              visible: !hookRow.missing && hookRow.status !== ""
              anchors.right: parent.right
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              width: actionText.implicitWidth + Style.space(12)
              height: actionText.implicitHeight + Style.space(6)
              radius: Style.cornerRadius
              color: actionMouse.containsMouse
                ? Style.hoverFillFor(root.barForeground, Color.accent)
                : Style.selectedFillFor(root.barForeground, Color.accent)

              Text {
                id: actionText
                anchors.centerIn: parent
                text: hookRow.installed ? "Remove" : "Install"
                color: root.barForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              MouseArea {
                id: actionMouse
                anchors.fill: parent
                hoverEnabled: true
                // Disabled while ANY agent's setup is running, not just this
                // row's, so a click during another install is never silently
                // swallowed by setupProc already being busy.
                enabled: root.busyAgent === ""
                cursorShape: Qt.PointingHandCursor
                onClicked: root.runSetup(hookRow.installed ? "remove" : "install", hookRow.modelData.id)
              }
            }
          }
        }

        PanelSeparator { foreground: root.barForeground }

        Text {
          width: parent.width
          leftPadding: Style.space(8)
          rightPadding: Style.space(8)
          wrapMode: Text.WordWrap
          text: "Click a session to focus its window · Middle-click the pill to refresh · Hooks apply to newly started agents"
          color: root.mutedForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
