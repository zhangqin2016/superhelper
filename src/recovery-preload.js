"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const channel = "app:database-recovery";
contextBridge.exposeInMainWorld("databaseRecovery", {
  act: (action, id) => ipcRenderer.invoke(channel, action, id),
  onChange: listener => { ipcRenderer.on(channel, (_event, state) => listener(state)); },
});
