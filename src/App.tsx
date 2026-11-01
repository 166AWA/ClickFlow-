import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Minus,
  Moon,
  Pin,
  Play,
  Square,
  Sun,
  X,
} from "lucide-react";

import {
  api,
  DEFAULT_SETTINGS,
  isTauri,
  mockApi,
  type HotkeyMode,
  type Settings,
  type Status,
} from "./lib/api";
import {
  Card,
  CardTitle,
  IconButton,
  IntervalSlider,
  Keycap,
  NumberField,
  Row,
  Segmented,
  StatBox,
} from "./components/ui";
import { cn, formatDuration, formatRate, MOUSE_CODES, prettyCombo } from "./lib/utils";

const client: typeof api = isTauri ? api : (mockApi as unknown as typeof api);
const appWindow = isTauri ? getCurrentWindow() : null;

/* ---------------- 键位捕获 ---------------- */

const NAMED_CODES = new Set([
  "Space", "Escape", "Enter", "Tab", "Backspace", "Delete", "Insert",
  "Home", "End", "PageUp", "PageDown", "Minus", "Equal", "BracketLeft",
  "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period",
  "Slash", "Backquote", "CapsLock", "PrintScreen", "ScrollLock", "Pause",
  "NumLock",
]);

const CODE_PATTERN =
  /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Numpad[0-9]|Arrow(Up|Down|Left|Right))$/;

const MOUSE_KEY_OPTIONS = [
  { code: "Mouse4", label: "侧键4", hint: "鼠标第 4 键（后退侧键）" },
  { code: "Mouse5", label: "侧键5", hint: "鼠标第 5 键（前进侧键）" },
  { code: "MouseM", label: "中键", hint: "滚轮中键" },
];

function codeOf(event: KeyboardEvent): string | null {
  const code = event.code;
  if (!code) return null;
  if (CODE_PATTERN.test(code) || NAMED_CODES.has(code)) return code;
  return null; // 纯修饰键：继续等主键
}

function comboOf(event: KeyboardEvent, code: string): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  parts.push(code);
  return parts.join("+");
}

/* ---------------- 主界面 ---------------- */

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<Status>({ running: false, clicks: 0, elapsedMs: 0 });
  const [capturing, setCapturing] = useState<"start" | "stop" | null>(null);
  const [pinned, setPinned] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);

  const [intervalText, setIntervalText] = useState("100");
  const [jitterText, setJitterText] = useState("0");
  const [limitText, setLimitText] = useState("0");

  const settingsRef = useRef(settings);
  const saveTimer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);
  const captureDoneRef = useRef(false);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  /* ---- 持久化 ---- */

  const persist = useCallback(
    async (next: Settings) => {
      try {
        const normalized = await client.saveSettings(next);
        setSettings((prev) => ({
          ...prev,
          hotkeyMode: normalized.hotkeyMode,
          startHotkey: normalized.startHotkey,
          stopHotkey: normalized.stopHotkey,
          islandPosition: normalized.islandPosition,
        }));
      } catch (err) {
        showToast(String(err), true);
        try {
          const fresh = await client.getSettings();
          setSettings(fresh);
          settingsRef.current = fresh;
          setIntervalText(String(fresh.intervalMs));
          setJitterText(String(fresh.jitterMs));
          setLimitText(String(fresh.limit));
        } catch {
          /* ignore */
        }
      }
    },
    [showToast]
  );

  const update = useCallback(
    (patch: Partial<Settings>, immediate = false) => {
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      setSettings(next);
      window.clearTimeout(saveTimer.current);
      if (immediate) {
        void persist(next);
      } else {
        saveTimer.current = window.setTimeout(() => void persist(next), 420);
      }
    },
    [persist]
  );

  /* ---- 初始化 ---- */

  useEffect(() => {
    const saved = localStorage.getItem("clickflow-theme");
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("clickflow-theme", theme);
  }, [theme]);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 窗口以 visible:false 启动以避免白屏闪烁，这里负责把它显示出来。
      // 放在最前面且单独 try，确保后续任何初始化异常都不会让窗口消失。
      try {
        if (appWindow) {
          await appWindow.show();
          await appWindow.setFocus();
        }
      } catch (err) {
        console.error(err);
      }

      try {
        const loaded = await client.getSettings();
        if (!alive) return;
        setSettings(loaded);
        settingsRef.current = loaded;
        setIntervalText(String(loaded.intervalMs));
        setJitterText(String(loaded.jitterMs));
        setLimitText(String(loaded.limit));

        setStatus(await client.status());
        const issue = await client.hotkeyError();
        if (issue) showToast(issue, true);
        if (appWindow) setPinned(await appWindow.isAlwaysOnTop());
      } catch (err) {
        console.error(err);
      }
    })();
    return () => {
      alive = false;
    };
  }, [showToast]);

  /* ---- 状态刷新 ---- */

  useEffect(() => {
    const id = window.setInterval(async () => {
      if (document.hidden) return;
      try {
        setStatus(await client.status());
      } catch {
        /* ignore */
      }
    }, 160);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void listen<Status>("clicker-state", (event) => setStatus(event.payload)).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  /* ---- 录制 ---- */

  const finishCapture = useCallback(
    async (patch?: Partial<Settings>) => {
      setCapturing(null);
      try {
        await client.pauseHotkeys(false);
      } catch {
        /* ignore */
      }
      if (patch) update(patch, true);
    },
    [update]
  );

  const beginCapture = useCallback(
    async (which: "start" | "stop") => {
      if (capturing) return;
      setCapturing(which);
      try {
        await client.pauseHotkeys(true);
      } catch {
        /* ignore */
      }
    },
    [capturing]
  );

  /** 把一次捕获结果写入设置（键盘与鼠标共用） */
  const commitCapture = useCallback(
    (combo: string) => {
      if (!capturing || captureDoneRef.current) return;
      captureDoneRef.current = true;

      const current = settingsRef.current;

      if (capturing === "start") {
        const patch: Partial<Settings> = { startHotkey: combo };
        if (current.hotkeyMode === "split" && current.stopHotkey === combo) {
          patch.stopHotkey = "";
        }
        void finishCapture(patch);
        showToast(`已绑定 ${prettyCombo(combo)}`);
      } else {
        if (combo === current.startHotkey) {
          captureDoneRef.current = false;
          showToast("停止键不能与启动键相同，请换一个", true);
          return;
        }
        void finishCapture({ stopHotkey: combo });
        showToast(`已绑定 ${prettyCombo(combo)}`);
      }
    },
    [capturing, finishCapture, showToast]
  );

  /** 直接指定鼠标键，不依赖录制 */
  const applyMouseKey = useCallback(
    (code: string) => {
      if (capturing) {
        commitCapture(code);
        return;
      }
      const current = settingsRef.current;
      const patch: Partial<Settings> = { startHotkey: code };
      if (current.hotkeyMode === "split" && current.stopHotkey === code) {
        patch.stopHotkey = "";
      }
      update(patch, true);
      showToast(`启动键已设为 ${prettyCombo(code)}`);
    },
    [capturing, commitCapture, update, showToast]
  );

  useEffect(() => {
    if (!capturing) return;
    captureDoneRef.current = false;

    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === "Escape") {
        captureDoneRef.current = true;
        void finishCapture();
        return;
      }

      const code = codeOf(event);
      if (!code) return;
      commitCapture(comboOf(event, code));
    };

    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-keycap]")) return;

      const mouseCode = MOUSE_CODES[event.button];
      if (mouseCode) {
        event.preventDefault();
        event.stopPropagation();
        commitCapture(mouseCode);
        return;
      }

      if (event.button === 0) {
        captureDoneRef.current = true;
        void finishCapture();
      }
    };

    // WebView 不一定把侧键派发给页面，靠后端低级钩子兜底（后端直接给字符串编码）
    let unlisten: (() => void) | undefined;
    if (isTauri) {
      void listen<string>("mouse-key-captured", (event) => {
        if (event.payload) commitCapture(event.payload);
      }).then((fn) => {
        unlisten = fn;
      });
    }

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      unlisten?.();
    };
  }, [capturing, commitCapture, finishCapture]);

  /* ---- 交互 ---- */

  const handleToggle = useCallback(async () => {
    try {
      const running = await client.toggle();
      setStatus((prev) => ({ ...prev, running }));
      if (!running) setStatus(await client.status());
    } catch (err) {
      showToast(String(err), true);
    }
  }, [showToast]);

  const commitNumber = useCallback(
    (key: "intervalMs" | "jitterMs" | "limit", raw: string, min: number, max: number) => {
      const parsed = Number(raw);
      const safe = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : min;
      update({ [key]: safe } as Partial<Settings>);
      return safe;
    },
    [update]
  );

  const running = status.running;

  /* ---- 渲染 ---- */

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="ambient" />

      {/* 标题栏 */}
      <header
        data-tauri-drag-region="true"
        className="relative z-10 flex h-12 shrink-0 items-center justify-between pl-4 pr-2"
      >
        <div data-tauri-drag-region="true" className="flex items-center gap-2.5">
          <Logo />
          <span className="text-[13px] font-semibold tracking-[0.01em]">ClickFlow</span>
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2 py-[1.5px] text-[10px] font-medium transition-colors",
              running
                ? "border-danger/35 bg-danger-soft text-danger"
                : "border-line bg-surface-2 text-fg-subtle"
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                running ? "animate-blink bg-danger" : "bg-success"
              )}
            />
            {running ? "运行中" : "待机"}
          </span>
        </div>

        <div className="flex items-center gap-0.5">
          <IconButton
            icon={Pin}
            label={pinned ? "取消置顶" : "窗口置顶"}
            active={pinned}
            onClick={async () => {
              if (!appWindow) return;
              const next = !pinned;
              await appWindow.setAlwaysOnTop(next);
              setPinned(next);
            }}
          />
          <IconButton
            icon={theme === "dark" ? Sun : Moon}
            label={theme === "dark" ? "切换到浅色" : "切换到深色"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          />
          <IconButton icon={Minus} label="最小化" onClick={() => void appWindow?.minimize()} />
          <IconButton
            icon={X}
            label="关闭"
            danger
            onClick={() => void appWindow?.close()}
          />
        </div>
      </header>

      {/* 内容 */}
      <main className="relative z-10 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-3 [&>*]:shrink-0">
        {/* 主开关 */}
        <button
          type="button"
          onClick={handleToggle}
          className={cn(
            "group relative w-full overflow-hidden rounded-2xl border p-3.5 text-left",
            "transition-all duration-200 hover:-translate-y-px active:translate-y-0 active:scale-[0.995]",
            running
              ? "border-danger/40 shadow-[0_14px_36px_-16px_rgba(244,63,94,0.65)]"
              : "border-primary/30 shadow-[var(--shadow-power)]"
          )}
        >
          <span
            className={cn(
              "absolute inset-0 transition-opacity duration-200",
              running
                ? "bg-gradient-to-br from-danger/18 via-surface to-surface"
                : "bg-gradient-to-br from-primary/18 via-surface to-surface"
            )}
          />
          <span className="relative flex items-center gap-3.5">
            <span
              className={cn(
                "grid size-11 shrink-0 place-items-center rounded-full text-white transition-all duration-200",
                running
                  ? "animate-pulse-ring bg-gradient-to-br from-danger to-orange-500"
                  : "bg-gradient-to-br from-primary to-accent shadow-[0_8px_20px_-8px_var(--primary)]"
              )}
            >
              {running ? (
                <Square className="size-[15px]" fill="currentColor" strokeWidth={0} />
              ) : (
                <Play className="size-[15px] translate-x-px" fill="currentColor" strokeWidth={0} />
              )}
            </span>

            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold leading-tight">
                {running ? "停止连点" : "开始连点"}
              </span>
              <span className="mt-0.5 block truncate text-[11.5px] text-fg-muted">
                每 {settings.intervalMs} ms 点击一次
                {settings.limit > 0 ? ` · 共 ${settings.limit} 次` : ""}
              </span>
            </span>

            <kbd className="max-w-[42%] shrink-0 truncate rounded-[7px] border border-line-strong bg-bg/50 px-2 py-1 font-mono text-[10.5px] font-semibold text-fg-muted">
              {prettyCombo(settings.startHotkey)}
            </kbd>
          </span>
        </button>

        {/* 统计 */}
        <div className="grid grid-cols-3 gap-2">
          <StatBox
            label="点击"
            value={status.clicks.toLocaleString("en-US")}
            highlight={running}
          />
          <StatBox label="时长" value={formatDuration(status.elapsedMs)} />
          <StatBox label="速率" value={`${formatRate(settings.intervalMs)}/s`} />
        </div>

        {/* 快捷键 */}
        <Card>
          <CardTitle
            action={
              <Segmented<HotkeyMode>
                value={settings.hotkeyMode}
                onChange={(mode) => {
                  const patch: Partial<Settings> = { hotkeyMode: mode };
                  if (mode === "split" && !settings.stopHotkey) patch.stopHotkey = "F7";
                  update(patch, true);
                }}
                options={[
                  { value: "toggle", label: "同一键" },
                  { value: "split", label: "双键" },
                ]}
              />
            }
          >
            快捷键
          </CardTitle>

          <Row label={settings.hotkeyMode === "toggle" ? "启动 / 停止" : "启动"}>
            <span data-keycap>
              <Keycap
                combo={settings.startHotkey}
                listening={capturing === "start"}
                onClick={() => void beginCapture("start")}
              />
            </span>
          </Row>

          <Row label="停止" hidden={settings.hotkeyMode === "toggle"}>
            <span data-keycap>
              <Keycap
                combo={settings.stopHotkey}
                listening={capturing === "stop"}
                onClick={() => void beginCapture("stop")}
              />
            </span>
          </Row>

          <p className="mt-2 text-[10.5px] leading-relaxed text-fg-subtle">
            点按键位后按键盘键或鼠标侧键，<kbd className="font-mono">Esc</kbd> 取消
          </p>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[10.5px] text-fg-subtle">鼠标键</span>
            {MOUSE_KEY_OPTIONS.map((item) => (
              <button
                key={item.code}
                type="button"
                title={item.hint}
                onClick={() => applyMouseKey(item.code)}
                className={cn(
                  "rounded-md border px-1.5 py-[2px] font-mono text-[10px] transition-colors",
                  settings.startHotkey === item.code
                    ? "border-primary/60 bg-primary-soft text-primary"
                    : "border-line bg-surface-2 text-fg-muted hover:border-primary/50 hover:text-primary"
                )}
              >
                {item.label}
              </button>
            ))}
            <span className="text-[10px] text-fg-subtle">点击直接设为启动键</span>
          </div>
        </Card>

        {/* 参数 */}
        <Card>
          <CardTitle>点击参数</CardTitle>

          <div className="flex items-center gap-3">
            <span className="shrink-0 text-[12px] text-fg-muted">间隔</span>
            <IntervalSlider
              value={Math.min(settings.intervalMs, 1000)}
              onChange={(value) => {
                setIntervalText(String(value));
                update({ intervalMs: value });
              }}
            />
            <div className="flex w-[76px] shrink-0 items-center gap-1 rounded-lg border border-line bg-surface-2 px-2 py-[5px] transition-colors focus-within:border-primary/70">
              <input
                type="number"
                inputMode="numeric"
                value={intervalText}
                min={1}
                max={600000}
                onChange={(event) => {
                  const raw = event.target.value;
                  setIntervalText(raw);
                  if (raw !== "") commitNumber("intervalMs", raw, 1, 600000);
                }}
                onBlur={() => {
                  const safe = commitNumber("intervalMs", intervalText, 1, 600000);
                  setIntervalText(String(safe));
                }}
                className="tnum w-full min-w-0 bg-transparent font-mono text-[12px] outline-none"
              />
              <span className="shrink-0 text-[9.5px] text-fg-subtle">ms</span>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <NumberField
              label="随机抖动 ±"
              value={jitterText}
              suffix="ms"
              min={0}
              max={5000}
              onChange={(raw) => {
                setJitterText(raw);
                if (raw !== "") commitNumber("jitterMs", raw, 0, 5000);
              }}
              onBlur={() => {
                const safe = commitNumber("jitterMs", jitterText, 0, 5000);
                setJitterText(String(safe));
              }}
            />
            <NumberField
              label="点击次数"
              value={limitText}
              suffix="0=∞"
              min={0}
              max={1000000000}
              onChange={(raw) => {
                setLimitText(raw);
                if (raw !== "") commitNumber("limit", raw, 0, 1000000000);
              }}
              onBlur={() => {
                const safe = commitNumber("limit", limitText, 0, 1000000000);
                setLimitText(String(safe));
              }}
            />
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-3">
            <span className="text-[12.5px] text-fg-muted">鼠标按键</span>
            <Segmented
              value={String(settings.button)}
              onChange={(value) =>
                update({ button: Number(value) as Settings["button"] }, true)
              }
              options={[
                { value: "0", label: "左键" },
                { value: "1", label: "右键" },
                { value: "2", label: "中键" },
              ]}
            />
          </div>
        </Card>

        {/* 灵动岛位置 */}
        <Card>
          <CardTitle>灵动岛位置</CardTitle>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            {[
              { value: "topLeft", label: "左上" },
              { value: "topCenter", label: "中上" },
              { value: "topRight", label: "右上" },
              { value: "bottomLeft", label: "左下" },
              { value: "", label: "" },
              { value: "bottomRight", label: "右下" },
            ].map((item, index) =>
              item.value ? (
                <button
                  key={item.value}
                  type="button"
                  onClick={() =>
                    update({ islandPosition: item.value as Settings["islandPosition"] }, true)
                  }
                  className={cn(
                    "rounded-lg border py-1.5 text-[11.5px] font-medium transition-colors",
                    settings.islandPosition === item.value
                      ? "border-primary/60 bg-primary-soft text-primary"
                      : "border-line bg-surface-2 text-fg-muted hover:border-primary/40 hover:text-primary"
                  )}
                >
                  {item.label}
                </button>
              ) : (
                <div
                  key={`gap-${index}`}
                  className="grid place-items-center text-[10px] text-fg-subtle/50"
                >
                  屏幕
                </div>
              )
            )}
          </div>
          <p className="mt-2 text-[10.5px] leading-relaxed text-fg-subtle">
            胶囊显示在所选位置：运行绿色、暂停红色，暂停 3 秒后自动收起
          </p>
        </Card>
      </main>

      {/* 底栏 */}
      <footer className="relative z-10 flex shrink-0 items-center gap-2 border-t border-line px-4 py-2.5 text-[10.5px] text-fg-subtle">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full transition-colors",
            running ? "animate-blink bg-danger" : "bg-success"
          )}
        />
        <span className="truncate">
          {prettyCombo(settings.startHotkey)}{" "}
          {settings.hotkeyMode === "toggle" ? "开关" : "启动"}
          {settings.hotkeyMode === "split" && settings.stopHotkey
            ? ` · ${prettyCombo(settings.stopHotkey)} 停止`
            : ""}
          ，最小化后依然生效
        </span>
      </footer>

      {/* 提示 */}
      {toast ? (
        <div
          className={cn(
            "animate-fade-up absolute bottom-12 left-1/2 z-20 max-w-[calc(100%-2rem)] rounded-lg border px-3 py-1.5",
            "text-center text-[11.5px] shadow-[0_10px_28px_-10px_rgba(0,0,0,0.6)]",
            toast.error
              ? "border-danger/45 bg-surface text-danger"
              : "border-line-strong bg-surface-3 text-fg"
          )}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- 标志 ---------------- */

function Logo() {
  return (
    <span className="grid size-[22px] shrink-0 place-items-center">
      <svg viewBox="0 0 24 24" fill="none" className="size-[22px]">
        <circle cx="12" cy="12" r="9" stroke="url(#cf-g)" strokeWidth="1.6" opacity="0.5" />
        <circle cx="12" cy="12" r="4.4" fill="url(#cf-g)" />
        <circle cx="12" cy="12" r="1.5" fill="#fff" opacity="0.92" />
        <defs>
          <linearGradient id="cf-g" x1="3" y1="3" x2="21" y2="21">
            <stop stopColor="#818cf8" />
            <stop offset="1" stopColor="#22d3ee" />
          </linearGradient>
        </defs>
      </svg>
    </span>
  );
}
