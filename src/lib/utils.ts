import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 毫秒 -> mm:ss */
export function formatDuration(ms: number) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/** 间隔 -> 每秒点击次数 */
export function formatRate(intervalMs: number) {
  const cps = 1000 / Math.max(1, intervalMs);
  if (cps >= 100) return `${Math.round(cps)}`;
  if (cps >= 10) return cps.toFixed(0);
  return cps.toFixed(1);
}

/** Tauri 键码 -> 展示文本，如 Ctrl+Shift+KeyK -> Ctrl + Shift + K */
export function prettyCombo(combo: string) {
  if (!combo) return "未设置";
  return combo
    .split("+")
    .map((part) => {
      if (part === "Ctrl") return "Ctrl";
      if (part === "Alt") return "Alt";
      if (part === "Shift") return "Shift";
      if (part === "Super") return "Win";
      if (part === "Mouse4") return "侧键4";
      if (part === "Mouse5") return "侧键5";
      if (part === "MouseM") return "中键";
      if (part.startsWith("MouseX")) return `侧键${part.slice(6)}`;
      if (part.startsWith("Key")) return part.slice(3);
      if (part.startsWith("Digit")) return part.slice(5);
      if (part.startsWith("Numpad")) return "Num" + part.slice(6);
      if (part.startsWith("Arrow")) return part.slice(5);
      return part;
    })
    .join(" + ");
}

/** 鼠标事件 button -> 内部编码 */
export const MOUSE_CODES: Partial<Record<number, string>> = {
  1: "MouseM", // 中键
  3: "Mouse4", // 侧键：后退
  4: "Mouse5", // 侧键：前进
};
