import { invoke } from "@tauri-apps/api/core";

export type HotkeyMode = "toggle" | "split";
export type MouseButton = 0 | 1 | 2;
export type IslandPosition =
  | "topLeft"
  | "topCenter"
  | "topRight"
  | "bottomLeft"
  | "bottomRight";

export interface Settings {
  hotkeyMode: HotkeyMode;
  startHotkey: string;
  stopHotkey: string;
  intervalMs: number;
  jitterMs: number;
  limit: number;
  button: MouseButton;
  islandPosition: IslandPosition;
}

export interface Status {
  running: boolean;
  clicks: number;
  elapsedMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  hotkeyMode: "toggle",
  startHotkey: "F6",
  stopHotkey: "F7",
  intervalMs: 100,
  jitterMs: 0,
  limit: 0,
  button: 0,
  islandPosition: "topCenter",
};

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  toggle: () => invoke<boolean>("toggle_clicker"),
  stop: () => invoke<boolean>("stop_clicker"),
  status: () => invoke<Status>("clicker_status"),
  hotkeyError: () => invoke<string | null>("hotkey_error"),
  pauseHotkeys: (paused: boolean) => invoke<void>("pause_hotkeys", { paused }),
};

/** 浏览器里跑（纯前端调试）时，给出一份假实现，方便单独预览界面 */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const mockApi = {
  settings: { ...DEFAULT_SETTINGS },
  running: false,
  clicks: 0,
  startedAt: 0,
  getSettings: async () => mockApi.settings,
  saveSettings: async (s: Settings) => {
    mockApi.settings = s;
    return s;
  },
  toggle: async () => {
    mockApi.running = !mockApi.running;
    return mockApi.running;
  },
  stop: async () => {
    mockApi.running = false;
    return false;
  },
  status: async () => ({
    running: mockApi.running,
    clicks: mockApi.clicks,
    elapsedMs: mockApi.startedAt ? Date.now() - mockApi.startedAt : 0,
  }),
  hotkeyError: async () => null,
  pauseHotkeys: async () => {},
};

// 浏览器预览用：?mock=running 可直接看到运行态
if (typeof location !== "undefined") {
  const mock = new URLSearchParams(location.search).get("mock");
  if (mock === "running") {
    mockApi.running = true;
    mockApi.clicks = 1284;
    mockApi.startedAt = Date.now() - 73_000;
  }
}
