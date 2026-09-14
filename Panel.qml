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
  readonly property color mutedForeground: Qt.darker(barForeground, 1.4)
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
  readonly property int installedHookCount: {
    var n = 0
    for (var k in hookStatus) if (hookStatus[k] === "installed") n++
    return n
  }
  // The Hooks section is a disclosure: collapsed by default, opened
  // automatically the first time we learn that nothing is installed yet.
  property bool hooksExpanded: false
  property bool hooksAutoDecided: false

  function stateColor(session) {
    var ds = Model.displayState(session)
    if (ds === "waiting") return root.waitingColor
    if (ds === "done") return root.doneColor
    if (ds === "working") return root.accentColor
    return root.mutedForeground
  }

  // Live window title of a session (Claude Code writes its task summary there).
  function windowTitleFor(session) {
    var win = session.windowAddress !== "" ? root.lookup[session.windowAddress] : null
    return win ? win.title : ""
  }

  function labelFor(session) { return Model.sessionLabel(session, windowTitleFor(session), Color.home) }
  function subtitleFor(session) { return Model.sessionSubtitle(session, Color.home) }

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
      onStreamFinished: {
        root.hookStatus = Model.parseHookStatus(text)
        if (!root.hooksAutoDecided) {
          root.hooksAutoDecided = true
          root.hooksExpanded = !root.anyHooksInstalled
        }
      }
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


  // Popup-card fill helper (same recipe the first-party panels use).
  function alpha(c, a) { return Qt.rgba(c.r, c.g, c.b, a) }
  readonly property color dimForeground: Qt.darker(barForeground, 1.4)
  readonly property color accentColor: Color.accent
  readonly property color urgentForeground: bar ? bar.urgent : Color.urgent

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
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
        spacing: Style.space(10)

        // ---------- Hero: camera mark · title · live summary ----------
        PanelHero {
          width: parent.width
          title: "Agent Watcher"
          meta: Model.summaryLine(root.summary)
          foreground: root.barForeground
          fontFamily: root.fontFamily

          iconComponent: Component {
            OpticalGlyph {
              width: Style.font.display
              height: Style.font.display
              text: Model.BAR_ICON
              fontFamily: root.fontFamily
              fontSize: Style.font.display
              color: root.summary.blink && root.host ? root.host.attentionColor : root.accentColor
            }
          }

          trailingControl: Component {
            PanelActionButton {
              iconText: ""
              tooltipText: "Refresh"
              foreground: root.barForeground
              hoverColor: root.accentColor
              fontFamily: root.fontFamily
              onClicked: if (root.host) root.host.requestDump()
            }
          }
        }

        PanelSeparator { foreground: root.barForeground }

        // ---------- Empty state ----------
        Column {
          visible: root.sessionList.length === 0
          width: parent.width
          spacing: Style.space(6)
          topPadding: Style.space(10)
          bottomPadding: Style.space(6)

          OpticalGlyph {
            anchors.horizontalCenter: parent.horizontalCenter
            width: Style.font.displayLarge
            height: Style.font.displayLarge
            text: Model.BAR_ICON
            fontFamily: root.fontFamily
            fontSize: Style.font.displayLarge
            color: root.alpha(root.dimForeground, 0.55)
          }

          Text {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            text: root.anyHooksInstalled
              ? "No sessions yet — start an agent in a terminal."
              : "Install hooks below to start tracking."
            color: root.dimForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }

        // ---------- One block per workspace ----------
        Repeater {
          model: root.groups

          Column {
            id: group
            required property var modelData
            width: content.width
            spacing: Style.space(4)

            PanelSectionHeader {
              leftPadding: Style.space(2)
              text: group.modelData.label.toUpperCase() + (group.modelData.current ? "  ·  CURRENT" : "")
              foreground: root.barForeground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: group.modelData.sessions

              Item {
                id: row
                required property var modelData
                readonly property bool attention: Model.needsAttention(modelData, root.blinkSettings)
                readonly property bool focusable: modelData.windowAddress !== ""
                readonly property string shownState: Model.displayState(modelData)
                readonly property color tone: root.stateColor(modelData)
                width: content.width
                implicitHeight: lines.implicitHeight + Style.space(14)
                height: implicitHeight

                // Card: quiet fill, brighter (accent-tinted) when it wants you.
                Rectangle {
                  anchors.fill: parent
                  radius: Style.cornerRadius
                  color: rowMouse.containsMouse && row.focusable
                    ? Style.hoverFillFor(root.barForeground, root.accentColor)
                    : (row.attention ? Style.selectedFillFor(root.barForeground, root.accentColor) : root.alpha(root.barForeground, 0.05))
                  Behavior on color { ColorAnimation { duration: 120 } }
                }

                // Colored edge on the rows that need attention.
                Rectangle {
                  visible: row.attention
                  anchors.left: parent.left
                  anchors.top: parent.top
                  anchors.bottom: parent.bottom
                  anchors.margins: Style.space(3)
                  width: Style.space(3)
                  radius: width / 2
                  color: row.tone
                }

                // State dot: breathes while working, ringed when waiting/done.
                Item {
                  id: dotBox
                  anchors.left: parent.left
                  anchors.leftMargin: Style.space(14)
                  anchors.verticalCenter: parent.verticalCenter
                  width: Style.space(14)
                  height: width

                  Rectangle {
                    visible: row.attention
                    anchors.centerIn: parent
                    width: parent.width
                    height: width
                    radius: width / 2
                    color: "transparent"
                    border.width: 1
                    border.color: root.alpha(row.tone, 0.55)
                  }

                  Rectangle {
                    id: dot
                    anchors.centerIn: parent
                    width: Style.space(8)
                    height: width
                    radius: width / 2
                    color: row.tone

                    SequentialAnimation on opacity {
                      running: row.shownState === "working"
                      loops: Animation.Infinite
                      NumberAnimation { to: 0.3; duration: 750; easing.type: Easing.InOutSine }
                      NumberAnimation { to: 1.0; duration: 750; easing.type: Easing.InOutSine }
                      onStopped: dot.opacity = 1
                    }
                  }
                }

                Column {
                  id: lines
                  anchors.left: dotBox.right
                  anchors.leftMargin: Style.space(10)
                  anchors.right: elapsed.left
                  anchors.rightMargin: Style.space(10)
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(3)

                  Row {
                    id: line1
                    width: parent.width
                    spacing: Style.space(8)

                    // Agent chip: the agent's glyph and name in its own color,
                    // bordered like the panel's tab buttons.
                    Rectangle {
                      id: agentChip
                      readonly property color agentColor: Model.agentColor(row.modelData.agent, root.accentColor)
                      anchors.verticalCenter: parent.verticalCenter
                      width: agentTag.implicitWidth + Style.space(12)
                      height: agentTag.implicitHeight + Style.space(4)
                      radius: Style.cornerRadius
                      color: root.alpha(agentColor, 0.10)
                      border.width: 1
                      border.color: root.alpha(agentColor, 0.55)

                      Row {
                        id: agentTag
                        anchors.centerIn: parent
                        spacing: Style.space(5)

                        Text {
                          anchors.verticalCenter: parent.verticalCenter
                          text: Model.agentGlyph(row.modelData.agent)
                          color: agentChip.agentColor
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.bodySmall
                        }

                        Text {
                          anchors.verticalCenter: parent.verticalCenter
                          text: row.modelData.agent.toUpperCase()
                          color: agentChip.agentColor
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                          font.bold: true
                          font.letterSpacing: 0.8
                        }
                      }
                    }

                    Text {
                      anchors.verticalCenter: parent.verticalCenter
                      text: root.labelFor(row.modelData)
                      textFormat: Text.PlainText   // agent-supplied text is never markup
                      color: root.barForeground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.subtitle
                      font.bold: true
                      elide: Text.ElideRight
                      width: Math.min(implicitWidth, Math.max(0, line1.width - agentChip.width - stateText.implicitWidth - line1.spacing * 2))
                    }

                    Text {
                      id: stateText
                      anchors.verticalCenter: parent.verticalCenter
                      text: row.shownState.toUpperCase()
                      color: row.tone
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: true
                      font.letterSpacing: 0.8
                    }
                  }

                  Text {
                    width: parent.width
                    text: root.subtitleFor(row.modelData)
                    textFormat: Text.PlainText
                    color: root.dimForeground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideMiddle
                  }
                }

                Text {
                  id: elapsed
                  anchors.right: parent.right
                  anchors.rightMargin: Style.space(12)
                  anchors.verticalCenter: parent.verticalCenter
                  text: Model.formatElapsed(row.modelData.stateSince, root.nowSec)
                  color: row.attention ? row.tone : root.dimForeground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: row.attention
                }

                MouseArea {
                  id: rowMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  acceptedButtons: Qt.LeftButton | Qt.RightButton
                  cursorShape: row.focusable ? Qt.PointingHandCursor : Qt.ArrowCursor
                  onClicked: function(mouse) {
                    if (mouse.button === Qt.RightButton) {
                      // Right-click dismisses a finished session; anything
                      // still working or waiting for you stays listed.
                      if (row.modelData.state === "done" && root.host)
                        root.host.dismissSession(row.modelData)
                    } else if (row.focusable) {
                      root.focusRow(row.modelData)
                    }
                  }
                }
              }
            }
          }
        }

        PanelSeparator { foreground: root.barForeground }

        // ---------- Hooks: a disclosure with one switch per agent ----------
        Item {
          id: hooksHeader
          width: parent.width
          height: hooksTitle.implicitHeight + Style.space(8)

          Rectangle {
            anchors.fill: parent
            radius: Style.cornerRadius
            color: hooksHeaderMouse.containsMouse ? Style.hoverFillFor(root.barForeground, root.accentColor) : "transparent"
          }

          PanelSectionHeader {
            id: hooksTitle
            anchors.left: parent.left
            anchors.leftMargin: Style.space(2)
            anchors.verticalCenter: parent.verticalCenter
            text: "HOOKS"
            foreground: root.barForeground
            fontFamily: root.fontFamily
          }

          Text {
            anchors.right: hooksChevron.left
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: root.hooksAutoDecided ? root.installedHookCount + " / " + Model.AGENTS.length + " installed" : ""
            color: root.installedHookCount > 0 ? root.doneColor : root.dimForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            id: hooksChevron
            anchors.right: parent.right
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: root.hooksExpanded ? "\uf077" : "\uf078"
            color: hooksHeaderMouse.containsMouse ? root.barForeground : root.dimForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          MouseArea {
            id: hooksHeaderMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.hooksExpanded = !root.hooksExpanded
          }
        }

        Column {
          id: hooksBody
          visible: root.hooksExpanded
          width: parent.width
          spacing: Style.space(10)

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
              readonly property color agentColor: Model.agentColor(modelData.id, root.accentColor)
              readonly property string caption: failed
                ? root.setupFailedText
                : (busy ? "working…"
                  : (Model.hookStatusLabel(status)
                    + (installed && modelData.id === "codex" ? "  ·  run /hooks in Codex once to trust" : "")))
              width: content.width
              height: hookLabels.implicitHeight + Style.space(12)

              Rectangle {
                anchors.fill: parent
                radius: Style.cornerRadius
                color: root.alpha(root.barForeground, 0.04)
              }

              // Agent mark in its own color, dimmed when the agent is not installed.
              Text {
                id: hookGlyph
                anchors.left: parent.left
                anchors.leftMargin: Style.space(12)
                anchors.verticalCenter: parent.verticalCenter
                text: Model.agentGlyph(hookRow.modelData.id)
                color: hookRow.missing ? root.dimForeground : hookRow.agentColor
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                width: Style.space(20)
                horizontalAlignment: Text.AlignHCenter
              }

              Column {
                id: hookLabels
                anchors.left: hookGlyph.right
                anchors.leftMargin: Style.space(10)
                anchors.right: hookSwitch.left
                anchors.rightMargin: Style.space(12)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(2)

                Text {
                  width: parent.width
                  text: hookRow.modelData.name
                  color: hookRow.missing ? root.dimForeground : root.barForeground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.bold: true
                  elide: Text.ElideRight
                }

                Text {
                  width: parent.width
                  text: hookRow.caption
                  textFormat: Text.PlainText   // may carry a stderr line from the setup script
                  color: hookRow.failed ? root.urgentForeground : (hookRow.installed ? root.doneColor : root.dimForeground)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }

              ToggleSwitch {
                id: hookSwitch
                visible: !hookRow.missing && hookRow.status !== ""
                anchors.right: parent.right
                anchors.rightMargin: Style.space(12)
                anchors.verticalCenter: parent.verticalCenter
                checked: hookRow.installed
                busy: hookRow.busy
                interactive: root.busyAgent === ""
                foreground: root.barForeground
                accent: hookRow.agentColor
                onToggled: root.runSetup(hookRow.installed ? "remove" : "install", hookRow.modelData.id)
              }
            }
          }
        }

        PanelSeparator { foreground: root.barForeground }

        Text {
          width: parent.width
          leftPadding: Style.space(2)
          rightPadding: Style.space(2)
          wrapMode: Text.WordWrap
          text: "Click a session to focus its window · Middle-click the pill to refresh · Remove hooks here before uninstalling the plugin"
          color: root.dimForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
