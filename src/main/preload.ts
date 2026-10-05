// Narrow bridge between renderer and main. No keys or tokens ever cross it.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type Handler<T> = (payload: T) => void;
const on = <T>(channel: string) => (fn: Handler<T>) => {
  const listener = (_e: IpcRendererEvent, payload: T) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api = {
  // overlay
  sendAudio: (speaker: "me" | "them", chunk: ArrayBuffer) => ipcRenderer.send("audio", speaker, chunk),
  startListening: () => ipcRenderer.invoke("listen:start"),
  stopListening: () => ipcRenderer.invoke("listen:stop"),
  requestTip: () => ipcRenderer.invoke("tip:request"),
  openSettings: () => ipcRenderer.invoke("settings:open"),
  hideOverlay: () => ipcRenderer.invoke("overlay:hide"),
  /** A capture track ended on its own (device unplugged): main stops listening and reports it. */
  captureEnded: (kind: "me" | "them", reason: string) => ipcRenderer.invoke("capture:ended", kind, reason),
  onTranscript: on("transcript"),
  onTip: on("tip"),
  onStatus: on("status"),
  onSettings: on("settings"),
  // settings window
  getState: () => ipcRenderer.invoke("state:get"),
  saveSettings: (s: unknown) => ipcRenderer.invoke("settings:save", s),
  setSecret: (name: string, value: string) => ipcRenderer.invoke("secret:set", name, value),
  getProfile: () => ipcRenderer.invoke("profile:get"),
  saveProfile: (p: unknown) => ipcRenderer.invoke("profile:save", p),
  getProfilePrompt: () => ipcRenderer.invoke("profile:prompt"),
  parseProfile: (text: string) => ipcRenderer.invoke("profile:parse", text),
  saveBrief: (text: string) => ipcRenderer.invoke("brief:save", text),
  chatgptSignIn: () => ipcRenderer.invoke("chatgpt:signin"),
  chatgptSignOut: () => ipcRenderer.invoke("chatgpt:signout"),
  chatgptUsage: () => ipcRenderer.invoke("chatgpt:usage"),
};

contextBridge.exposeInMainWorld("coach", api);
export type CoachApi = typeof api;
