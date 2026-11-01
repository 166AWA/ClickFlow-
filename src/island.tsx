import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isTauri, mockApi } from "./lib/api";
import "./index.css";

interface IslandPayload {
  running: boolean;
  clicks: number;
}

const client: typeof api = isTauri ? api : (mockApi as unknown as typeof api);

/**
 * 灵动岛胶囊：运行 = 绿色，暂停 = 红色。
 * 显隐由后端控制（暂停 3 秒后收回窗口），这里只负责把状态画出来。
 */
function Island() {
  const [running, setRunning] = useState(true);
  const [clicks, setClicks] = useState(0);
  const runningRef = useRef(true);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  // 事件驱动：状态切换立刻反映到颜色
  useEffect(() => {
    if (!isTauri) {
      const paused = new URLSearchParams(location.search).get("mock") === "paused";
      setRunning(!paused);
      setClicks(paused ? 0 : 1284);
      return;
    }
    let unlisten: (() => void) | undefined;
    void listen<IslandPayload>("island-state", (event) => {
      setRunning(event.payload.running);
      setClicks(event.payload.clicks);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // 轮询：刷新计数，并兜底同步运行状态
  useEffect(() => {
    if (!isTauri) return;
    const id = window.setInterval(async () => {
      try {
        const status = await client.status();
        setClicks(status.clicks);
        if (status.running !== runningRef.current) setRunning(status.running);
      } catch {
        /* ignore */
      }
    }, 220);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="island-root">
      <div className={`island-pill ${running ? "is-running" : "is-paused"}`}>
        <span className="island-dot" />
        <span className="island-label">{running ? "运行中" : "已暂停"}</span>
        <span className="island-spacer" />
        {running ? (
          <span className="island-count tnum">
            {clicks.toLocaleString("en-US")}
            <span className="island-unit"> 次</span>
          </span>
        ) : (
          <span className="island-hint">3s 后返回</span>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Island />);
