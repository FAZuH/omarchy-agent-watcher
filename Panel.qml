import QtQuick
import qs.Ui

Panel {
  id: root
  moduleName: "io.github.5d0tal1gat0r.agent-watcher"
  manageIpc: false
  property var anchorItem: null
  property var hostWidget: null
  property var host: null
  function open() { root.controller.show() }
  function close() { root.controller.hide() }
  function toggle() { root.opened ? close() : open() }
}
