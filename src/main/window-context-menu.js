"use strict";

const { Menu } = require("electron");

/**
 * Native edit context menu for text fields and selected chat text.
 * Custom renderer menus (e.g. session sidebar) still handle their own contextmenu.
 */
function wireContextMenu(win) {
  win.webContents.on("context-menu", (_event, params) => {
    const template = [];

    if (params.isEditable) {
      template.push(
        { role: "undo", enabled: params.editFlags.canUndo },
        { role: "redo", enabled: params.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "delete", enabled: params.editFlags.canDelete },
        { type: "separator" },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      template.push({ role: "copy" });
    }

    if (!template.length) return;

    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

module.exports = { wireContextMenu };
