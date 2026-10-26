const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("dronsio", {
  getState: invoke("get-state"),
  setSettings: invoke("set-settings"),
  resetShortcuts: invoke("reset-shortcuts"),
  clearShortcut: invoke("clear-shortcut"),
  captureShortcut: invoke("capture-shortcut"),
  cancelCapture: invoke("cancel-capture"),
  copy: invoke("copy"),
  deleteHistory: invoke("delete-history"),
  saveNote: invoke("save-note"),
  deleteNote: invoke("delete-note"),
  agentConfirm: invoke("agent-confirm"),
  cancelAgent: invoke("cancel-agent"),
  pickWorkDir: invoke("pick-work-dir"),
  startMeeting: invoke("start-meeting"),
  stopMeeting: invoke("stop-meeting"),
  deleteMeeting: invoke("delete-meeting"),
  listMicrophones: invoke("list-microphones"),
  refreshOllama: invoke("refresh-ollama"),
  retryModel: invoke("retry-model"),
  dismissError: invoke("dismiss-error"),
  openFolder: invoke("open-folder"),
  quit: invoke("quit"),
  onState: (cb) => ipcRenderer.on("state", (_e, s) => cb(s)),
  onLevel: (cb) => ipcRenderer.on("level", (_e, l) => cb(l)),
});
