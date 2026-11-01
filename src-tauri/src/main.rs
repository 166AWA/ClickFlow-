// ClickFlow — 轻量级高速连点器
// 后端：Rust + Tauri v2。鼠标事件直接走 Win32 SendInput，无第三方输入库。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const EVT_STATE: &str = "clicker-state";
const EVT_ISLAND: &str = "island-state";
/// 灵动岛胶囊的窗口尺寸（逻辑像素）——略大于 eIsland 默认岛，完整覆盖它
const ISLAND_W: f64 = 276.0;
const ISLAND_H: f64 = 58.0;
/// 暂停后多久收回胶囊、让位给系统/其他灵动岛的默认显示
const ISLAND_LINGER: Duration = Duration::from_secs(3);

/// 连点器自己注入的鼠标事件带上这个标记，鼠标钩子据此忽略，
/// 避免「用中键当启动键」时连点把自己触发成死循环。
/// 用自定义标记而不是 LLMHF_INJECTED，是为了不误伤其他软件模拟的按键。
const CLICKFLOW_EVENT_TAG: usize = 0x434C_464C;

/* ------------------------------------------------------------------ */
/*  设置模型                                                            */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    /// "toggle" = 同一个键开关；"split" = 启动键 / 停止键分离
    hotkey_mode: String,
    start_hotkey: String,
    stop_hotkey: String,
    interval_ms: u64,
    jitter_ms: u64,
    /// 0 表示无限
    limit: u64,
    /// 0 = 左键, 1 = 右键, 2 = 中键
    button: u8,
    /// 灵动岛胶囊位置：topCenter / topLeft / topRight / bottomLeft / bottomRight
    #[serde(default = "default_island_position")]
    island_position: String,
}

fn default_island_position() -> String {
    "topCenter".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey_mode: "toggle".into(),
            start_hotkey: "F6".into(),
            stop_hotkey: "F7".into(),
            interval_ms: 100,
            jitter_ms: 0,
            limit: 0,
            button: 0,
            island_position: default_island_position(),
        }
    }
}

impl Settings {
    fn normalized(mut self) -> Self {
        self.interval_ms = self.interval_ms.clamp(1, 600_000);
        self.jitter_ms = self.jitter_ms.min(self.interval_ms.saturating_sub(1));
        self.limit = self.limit.min(1_000_000_000);
        if self.button > 2 {
            self.button = 0;
        }
        if self.hotkey_mode != "split" {
            self.hotkey_mode = "toggle".into();
        }
        self.start_hotkey = self.start_hotkey.trim().to_string();
        self.stop_hotkey = self.stop_hotkey.trim().to_string();
        let position = self.island_position.trim().to_string();
        self.island_position = match position.as_str() {
            "topLeft" | "topRight" | "bottomLeft" | "bottomRight" => position.clone(),
            _ => default_island_position(),
        };
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    running: bool,
    clicks: u64,
    elapsed_ms: u64,
}

/// 推送给灵动岛浮窗的状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IslandState {
    running: bool,
    clicks: u64,
}

/* ------------------------------------------------------------------ */
/*  运行时状态（无锁原子量，供点击线程高频读写）                          */
/* ------------------------------------------------------------------ */

struct Shared {
    settings: Mutex<Settings>,
    hotkeys_paused: AtomicBool,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            settings: Mutex::new(Settings::default()),
            hotkeys_paused: AtomicBool::new(false),
        }
    }
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static CLICKS: AtomicU64 = AtomicU64::new(0);
/// 每次启动递增。旧线程发现代数不匹配会立刻自杀，避免「停止后马上启动」
/// 时两个点击线程同时工作导致速度翻倍。
static GENERATION: AtomicU64 = AtomicU64::new(0);
static STARTED_AT: Mutex<Option<Instant>> = Mutex::new(None);
/// 最近一次热键注册失败的原因，供界面提示用户
static HOTKEY_ERROR: Mutex<Option<String>> = Mutex::new(None);
/// 灵动岛隐藏计时器的代号：新一次显示会顶掉尚未执行的隐藏
static ISLAND_HIDE_GEN: AtomicU64 = AtomicU64::new(0);

fn set_hotkey_error(message: Option<String>) {
    if let Ok(mut guard) = HOTKEY_ERROR.lock() {
        *guard = message;
    }
}

/* ------------------------------------------------------------------ */
/*  Win32 鼠标注入                                                      */
/* ------------------------------------------------------------------ */

#[cfg(windows)]
mod mouse {
    // 手写 FFI：省掉整个 windows crate 的编译时间与体积，调用开销为零。
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MouseInput {
        dx: i32,
        dy: i32,
        mouse_data: u32,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    /// INPUT 联合体在 x64 下固定 40 字节（type 4 + padding 4 + MOUSEINPUT 32）
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Input {
        kind: u32,
        _pad: u32,
        mi: MouseInput,
    }

    const INPUT_MOUSE: u32 = 0;
    const LEFTDOWN: u32 = 0x0002;
    const LEFTUP: u32 = 0x0004;
    const RIGHTDOWN: u32 = 0x0008;
    const RIGHTUP: u32 = 0x0010;
    const MIDDLEDOWN: u32 = 0x0020;
    const MIDDLEUP: u32 = 0x0040;

    #[link(name = "user32")]
    extern "system" {
        fn SendInput(cinputs: u32, pinputs: *const Input, cb_size: i32) -> u32;
    }

    #[link(name = "winmm")]
    extern "system" {
        fn timeBeginPeriod(period: u32) -> u32;
        fn timeEndPeriod(period: u32) -> u32;
    }

    const _: () = assert!(std::mem::size_of::<Input>() == 40);

    pub fn boost_timer() {
        unsafe {
            timeBeginPeriod(1);
        }
    }

    pub fn restore_timer() {
        unsafe {
            timeEndPeriod(1);
        }
    }

    #[inline(always)]
    pub fn click(button: u8) {
        let (down, up) = match button {
            1 => (RIGHTDOWN, RIGHTUP),
            2 => (MIDDLEDOWN, MIDDLEUP),
            _ => (LEFTDOWN, LEFTUP),
        };
        let build = |flags: u32| Input {
            kind: INPUT_MOUSE,
            _pad: 0,
            mi: MouseInput {
                dx: 0,
                dy: 0,
                mouse_data: 0,
                flags,
                time: 0,
                extra_info: super::CLICKFLOW_EVENT_TAG,
            },
        };
        // 按下与抬起一次投递，减少两次系统调用的开销
        let events = [build(down), build(up)];
        unsafe {
            SendInput(
                events.len() as u32,
                events.as_ptr(),
                std::mem::size_of::<Input>() as i32,
            );
        }
    }
}

#[cfg(not(windows))]
mod mouse {
    pub fn boost_timer() {}
    pub fn restore_timer() {}
    pub fn click(_button: u8) {}
}

/* ------------------------------------------------------------------ */
/*  全局鼠标钩子                                                        */
/*  RegisterHotKey 只支持键盘，鼠标侧键必须靠 WH_MOUSE_LL 捕获。        */
/*  钩子只监听、不拦截（始终 CallNextHookEx），不影响系统正常行为。      */
/* ------------------------------------------------------------------ */

#[cfg(windows)]
mod mouse_hook {
    use std::sync::mpsc::Sender;
    use std::sync::OnceLock;

    type Handle = *mut core::ffi::c_void;

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct MsllHookStruct {
        pt: Point,
        mouse_data: u32,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    #[repr(C)]
    struct Msg {
        hwnd: Handle,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        pt: Point,
    }

    const WH_MOUSE_LL: i32 = 14;
    const WM_MBUTTONDOWN: usize = 0x0207;
    const WM_XBUTTONDOWN: usize = 0x020B;

    type HookProc = Option<unsafe extern "system" fn(i32, usize, isize) -> isize>;

    #[link(name = "user32")]
    extern "system" {
        fn SetWindowsHookExW(id_hook: i32, lpfn: HookProc, hmod: Handle, thread_id: u32) -> Handle;
        fn CallNextHookEx(hhk: Handle, code: i32, wparam: usize, lparam: isize) -> isize;
        fn UnhookWindowsHookEx(hhk: Handle) -> i32;
        fn GetMessageW(msg: *mut Msg, hwnd: Handle, min: u32, max: u32) -> i32;
        fn TranslateMessage(msg: *const Msg) -> i32;
        fn DispatchMessageW(msg: *const Msg) -> isize;
    }

    static TX: OnceLock<Sender<u32>> = OnceLock::new();

    unsafe extern "system" fn hook_proc(code: i32, wparam: usize, lparam: isize) -> isize {
        // 钩子回调必须极快：只做判断和投递，绝不做 I/O
        if code >= 0 && (wparam == WM_XBUTTONDOWN || wparam == WM_MBUTTONDOWN) {
            let info = &*(lparam as *const MsllHookStruct);
            if info.extra_info != super::CLICKFLOW_EVENT_TAG {
                let button = match wparam {
                    // 高字是 XBUTTON 编号：1 = 后退侧键，2 = 前进侧键
                    WM_XBUTTONDOWN => {
                        let which = (info.mouse_data >> 16) & 0xFFFF;
                        if which > 0 {
                            Some(which)
                        } else {
                            None
                        }
                    }
                    WM_MBUTTONDOWN => Some(0),
                    _ => None,
                };
                if let Some(id) = button {
                    if let Some(tx) = TX.get() {
                        let _ = tx.send(id);
                    }
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    /// 在独立线程里装钩子并跑消息循环（低级钩子必须在有消息循环的线程上）
    pub fn start(tx: Sender<u32>) {
        let _ = TX.set(tx);
        let _ = std::thread::Builder::new()
            .name("clickflow-mouse-hook".into())
            .spawn(|| unsafe {
                let hook =
                    SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), std::ptr::null_mut(), 0);
                if hook.is_null() {
                    eprintln!(
                        "[ClickFlow] 鼠标钩子安装失败: {}",
                        std::io::Error::last_os_error()
                    );
                    return;
                }
                let mut msg: Msg = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                UnhookWindowsHookEx(hook);
            });
    }
}

#[cfg(not(windows))]
mod mouse_hook {
    use std::sync::mpsc::Sender;
    pub fn start(_tx: Sender<u32>) {}
}

/* ------------------------------------------------------------------ */
/*  高精度等待                                                          */
/* ------------------------------------------------------------------ */

/// 最后 ~1ms 用自旋收尾，避免 Windows 定时器抖动吃掉精度
fn precise_sleep(total: Duration) {
    const SPIN: Duration = Duration::from_micros(1100);
    if total > SPIN {
        std::thread::sleep(total - SPIN);
    }
    let begin = Instant::now();
    while begin.elapsed() < total {
        std::hint::spin_loop();
    }
}

/// 该线程是否仍是被认可的那一个
#[inline]
fn still_active(generation: u64) -> bool {
    RUNNING.load(Ordering::Relaxed) && GENERATION.load(Ordering::Relaxed) == generation
}

/// 可被「停止」立刻打断的分段等待（最长阻塞 ~8ms）
fn wait_interval(total: Duration, generation: u64) {
    let deadline = Instant::now() + total;
    loop {
        if !still_active(generation) {
            return;
        }
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        let remain = deadline - now;
        if remain > Duration::from_millis(16) {
            std::thread::sleep(Duration::from_millis(8));
        } else {
            precise_sleep(remain);
            return;
        }
    }
}

#[inline]
fn pseudo_rand() -> u64 {
    static SEED: AtomicU64 = AtomicU64::new(0x2545_F491_4F6C_DD1D);
    let mut x = SEED.load(Ordering::Relaxed);
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    SEED.store(x, Ordering::Relaxed);
    x
}

/* ------------------------------------------------------------------ */
/*  点击线程                                                            */
/* ------------------------------------------------------------------ */

#[derive(Clone, Copy)]
struct ClickCfg {
    button: u8,
    interval: Duration,
    jitter_us: u64,
    limit: u64,
}

fn spawn_clicker(app: AppHandle, cfg: ClickCfg, generation: u64) {
    let _ = std::thread::Builder::new()
        .name("clickflow-worker".into())
        .spawn(move || {
            let base_us = cfg.interval.as_micros() as u64;
            let mut count: u64 = 0;

            while still_active(generation) {
                mouse::click(cfg.button);
                count += 1;
                CLICKS.store(count, Ordering::Relaxed);

                if cfg.limit > 0 && count >= cfg.limit {
                    break;
                }

                let mut wait_us = base_us;
                if cfg.jitter_us > 0 {
                    let span = cfg.jitter_us * 2 + 1;
                    wait_us = base_us
                        .saturating_sub(cfg.jitter_us)
                        .saturating_add(pseudo_rand() % span);
                }
                wait_interval(Duration::from_micros(wait_us.max(200)), generation);
            }

            // 只有仍属当前这一代时才清运行标志，否则会把新一轮的状态误清掉
            if GENERATION.load(Ordering::SeqCst) == generation {
                // swap 返回 true 说明是「跑够次数自然停下」，而不是被 end() 停的
                let stopped_here = RUNNING.swap(false, Ordering::SeqCst);
                emit_state(&app);
                if stopped_here {
                    island_paused(&app);
                }
            } else {
                emit_state(&app);
            }
        });
}

/* ------------------------------------------------------------------ */
/*  状态广播                                                            */
/* ------------------------------------------------------------------ */

fn elapsed_ms() -> u64 {
    match STARTED_AT.lock() {
        Ok(guard) => guard
            .as_ref()
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(0),
        Err(_) => 0,
    }
}

fn current_status() -> Status {
    Status {
        running: RUNNING.load(Ordering::Relaxed),
        clicks: CLICKS.load(Ordering::Relaxed),
        elapsed_ms: elapsed_ms(),
    }
}

fn emit_state(app: &AppHandle) {
    let _ = app.emit(EVT_STATE, current_status());
}

/* ------------------------------------------------------------------ */
/*  灵动岛浮窗                                                          */
/*  运行 → 绿色胶囊常驻；暂停 → 红色胶囊停留 3 秒后自动收回。            */
/* ------------------------------------------------------------------ */

/// 把胶囊显示出来并置顶（不抢焦点），同时顶掉尚未执行的隐藏
fn island_reveal(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    ISLAND_HIDE_GEN.fetch_add(1, Ordering::SeqCst);
    let window = app.get_webview_window("island")?;
    // 每次显示前重新定位，「中上」可跟随 eIsland 岛的实时位置
    let position = settings_of(app).island_position;
    position_island(app, &position);
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    Some(window)
}

fn island_running(app: &AppHandle) {
    if let Some(window) = island_reveal(app) {
        let _ = window.emit(
            EVT_ISLAND,
            IslandState {
                running: true,
                clicks: CLICKS.load(Ordering::Relaxed),
            },
        );
    }
}

fn island_paused(app: &AppHandle) {
    if let Some(window) = island_reveal(app) {
        let _ = window.emit(
            EVT_ISLAND,
            IslandState {
                running: false,
                clicks: CLICKS.load(Ordering::Relaxed),
            },
        );
    }

    // 停留 3 秒后收回，让位给默认灵动岛
    let generation = ISLAND_HIDE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("clickflow-island-hide".into())
        .spawn(move || {
            std::thread::sleep(ISLAND_LINGER);
            // 期间又开始了新一轮显示，或已重新运行，就不收回
            if ISLAND_HIDE_GEN.load(Ordering::SeqCst) != generation
                || RUNNING.load(Ordering::SeqCst)
            {
                return;
            }
            if let Some(window) = app.get_webview_window("island") {
                let _ = window.hide();
            }
        });
}

/* ------------------------------------------------------------------ */
/*  启动 / 停止                                                         */
/* ------------------------------------------------------------------ */

fn begin(app: &AppHandle, s: &Settings) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    CLICKS.store(0, Ordering::SeqCst);
    if let Ok(mut guard) = STARTED_AT.lock() {
        *guard = Some(Instant::now());
    }
    spawn_clicker(
        app.clone(),
        ClickCfg {
            button: s.button,
            interval: Duration::from_millis(s.interval_ms),
            jitter_us: s.jitter_ms.saturating_mul(1000),
            limit: s.limit,
        },
        generation,
    );
    emit_state(app);
    island_running(app);
}

fn end(app: &AppHandle) {
    RUNNING.store(false, Ordering::SeqCst);
    emit_state(app);
    island_paused(app);
}

fn settings_of(app: &AppHandle) -> Settings {
    let shared = app.state::<Shared>();
    shared
        .settings
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

/* ------------------------------------------------------------------ */
/*  全局快捷键                                                          */
/* ------------------------------------------------------------------ */

fn parse_hotkey(raw: &str) -> Option<Shortcut> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<Shortcut>().ok()
}

/// 只比较修饰键与主键，忽略内部 id
fn same_hotkey(a: &Shortcut, b: &Shortcut) -> bool {
    a.mods == b.mods && a.key == b.key
}

/// 鼠标键统一编码（内部用数字，对外一律用字符串，避免前后端两套编码错位）：
/// 0 = 中键，1 = XBUTTON1(侧键4/后退)，2 = XBUTTON2(侧键5/前进)，其他为厂商扩展键
fn mouse_code(button: u32) -> String {
    match button {
        0 => "MouseM".to_string(),
        1 => "Mouse4".to_string(),
        2 => "Mouse5".to_string(),
        n => format!("MouseX{n}"),
    }
}

fn mouse_button_id(raw: &str) -> Option<u32> {
    match raw.trim() {
        "MouseM" => Some(0),
        "Mouse4" => Some(1),
        "Mouse5" => Some(2),
        other => other
            .strip_prefix("MouseX")
            .and_then(|rest| rest.parse::<u32>().ok())
            .filter(|n| *n > 0),
    }
}

fn mouse_matches(raw: &str, button: u32) -> bool {
    mouse_button_id(raw) == Some(button)
}

fn apply_hotkeys(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();

    // 鼠标键不参与 RegisterHotKey，交给全局鼠标钩子处理
    let start_is_mouse = mouse_button_id(&s.start_hotkey).is_some();
    let stop_is_mouse = mouse_button_id(&s.stop_hotkey).is_some();

    let mut keys: Vec<Shortcut> = Vec::new();
    if !start_is_mouse {
        if let Some(k) = parse_hotkey(&s.start_hotkey) {
            keys.push(k);
        }
    }
    if s.hotkey_mode == "split" && !stop_is_mouse {
        if let Some(k) = parse_hotkey(&s.stop_hotkey) {
            if !keys.iter().any(|existing| same_hotkey(existing, &k)) {
                keys.push(k);
            }
        }
    }

    if keys.is_empty() && !start_is_mouse && !stop_is_mouse {
        let msg = "尚未设置有效的快捷键".to_string();
        set_hotkey_error(Some(msg.clone()));
        return Err(msg);
    }

    for key in keys {
        if let Err(e) = manager.register(key) {
            let msg = format!("快捷键注册失败，可能被其他程序占用：{e}");
            set_hotkey_error(Some(msg.clone()));
            return Err(msg);
        }
    }

    set_hotkey_error(None);
    Ok(())
}

/// 返回 true 表示这个热键是「启动」键
fn is_start_key(shortcut: &Shortcut, s: &Settings) -> bool {
    parse_hotkey(&s.start_hotkey).map_or(false, |k| same_hotkey(&k, shortcut))
}

fn is_stop_key(shortcut: &Shortcut, s: &Settings) -> bool {
    parse_hotkey(&s.stop_hotkey).map_or(false, |k| same_hotkey(&k, shortcut))
}

/// 键盘与鼠标两条链路共用的触发逻辑
fn dispatch_trigger(app: &AppHandle, s: &Settings, start: bool, stop: bool) {
    if !start && !stop {
        return;
    }

    let toggle_mode = s.hotkey_mode != "split" || (start && stop);

    if toggle_mode {
        if RUNNING.load(Ordering::SeqCst) {
            end(app);
        } else {
            begin(app, s);
        }
    } else if start {
        if !RUNNING.load(Ordering::SeqCst) {
            begin(app, s);
        }
    } else if stop {
        if RUNNING.load(Ordering::SeqCst) {
            end(app);
        }
    }
}

fn handle_hotkey(app: &AppHandle, shortcut: &Shortcut) {
    let shared = app.state::<Shared>();
    if shared.hotkeys_paused.load(Ordering::SeqCst) {
        return;
    }
    let s = match shared.settings.lock() {
        Ok(g) => g.clone(),
        Err(_) => return,
    };

    dispatch_trigger(app, &s, is_start_key(shortcut, &s), is_stop_key(shortcut, &s));
}

fn handle_mouse_button(app: &AppHandle, button: u32) {
    let shared = app.state::<Shared>();
    if shared.hotkeys_paused.load(Ordering::SeqCst) {
        return;
    }
    let s = match shared.settings.lock() {
        Ok(g) => g.clone(),
        Err(_) => return,
    };

    dispatch_trigger(
        app,
        &s,
        mouse_matches(&s.start_hotkey, button),
        mouse_matches(&s.stop_hotkey, button),
    );
}

/// 启动鼠标钩子并把事件转交到独立线程处理，避免阻塞系统输入
fn spawn_mouse_hook(app: AppHandle) {
    let (tx, rx) = std::sync::mpsc::channel::<u32>();
    mouse_hook::start(tx);

    let _ = std::thread::Builder::new()
        .name("clickflow-mouse-dispatch".into())
        .spawn(move || {
            while let Ok(button) = rx.recv() {
                let shared = app.state::<Shared>();
                // 录制键位期间把按键推给界面，而不是当成触发
                if shared.hotkeys_paused.load(Ordering::SeqCst) {
                    // 统一用字符串传，前端不需要再转换
                    let _ = app.emit("mouse-key-captured", mouse_code(button));
                    continue;
                }
                handle_mouse_button(&app, button);
            }
        });
}

/* ------------------------------------------------------------------ */
/*  设置持久化                                                          */
/* ------------------------------------------------------------------ */

fn settings_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .map(|s| s.normalized())
        .unwrap_or_default()
}

fn persist(app: &AppHandle, s: &Settings) {
    if let Some(path) = settings_file(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(s) {
            let _ = std::fs::write(path, text);
        }
    }
}

/* ------------------------------------------------------------------ */
/*  命令                                                                */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn get_settings(state: State<'_, Shared>) -> Settings {
    state
        .settings
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<'_, Shared>, settings: Settings) -> Result<Settings, String> {
    let next = settings.normalized();

    let previous = {
        let mut guard = state.settings.lock().map_err(|_| "内部状态异常".to_string())?;
        let prev = guard.clone();
        *guard = next.clone();
        prev
    };

    let hotkeys_changed = previous.start_hotkey != next.start_hotkey
        || previous.stop_hotkey != next.stop_hotkey
        || previous.hotkey_mode != next.hotkey_mode;
    let position_changed = previous.island_position != next.island_position;

    if hotkeys_changed || state.hotkeys_paused.load(Ordering::SeqCst) {
        state.hotkeys_paused.store(false, Ordering::SeqCst);
        if let Err(err) = apply_hotkeys(&app, &next) {
            // 注册失败：回滚到上一份可用配置
            if let Ok(mut guard) = state.settings.lock() {
                *guard = previous.clone();
            }
            let _ = apply_hotkeys(&app, &previous);
            position_island(&app, &previous.island_position);
            return Err(err);
        }
    }

    persist(&app, &next);
    if position_changed {
        position_island(&app, &next.island_position);
    }
    Ok(next)
}

#[tauri::command]
fn toggle_clicker(app: AppHandle) -> bool {
    if RUNNING.load(Ordering::SeqCst) {
        end(&app);
        false
    } else {
        let s = settings_of(&app);
        begin(&app, &s);
        true
    }
}

#[tauri::command]
fn start_clicker(app: AppHandle) -> bool {
    let s = settings_of(&app);
    begin(&app, &s);
    true
}

#[tauri::command]
fn stop_clicker(app: AppHandle) -> bool {
    end(&app);
    false
}

#[tauri::command]
fn clicker_status() -> Status {
    current_status()
}

/// 返回当前热键是否注册成功；Some(原因) 表示存在问题
#[tauri::command]
fn hotkey_error() -> Option<String> {
    HOTKEY_ERROR.lock().ok().and_then(|g| g.clone())
}

/// 录制快捷键期间临时摘掉全局热键，避免「按下要绑定的键」直接触发连点
#[tauri::command]
fn pause_hotkeys(app: AppHandle, paused: bool) -> Result<(), String> {
    let state = app.state::<Shared>();
    state.hotkeys_paused.store(paused, Ordering::SeqCst);
    if paused {
        let _ = app.global_shortcut().unregister_all();
        Ok(())
    } else {
        let s = settings_of(&app);
        apply_hotkeys(&app, &s)
    }
}

/* ------------------------------------------------------------------ */
/*  入口                                                                */
/* ------------------------------------------------------------------ */

/// 取主显示器工作区（排除任务栏），物理像素
#[cfg(windows)]
fn work_area() -> Option<(i32, i32, i32, i32)> {
    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn SystemParametersInfoW(action: u32, param: u32, pv: *mut Rect, winini: u32) -> i32;
    }
    const SPI_GETWORKAREA: u32 = 0x0030;
    let mut rect = Rect {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let ok = unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut rect, 0) };
    if ok != 0 {
        Some((rect.left, rect.top, rect.right, rect.bottom))
    } else {
        None
    }
}

#[cfg(not(windows))]
fn work_area() -> Option<(i32, i32, i32, i32)> {
    None
}

/// 创建灵动岛浮窗：透明、无边框、置顶、不占任务栏、不抢焦点
fn create_island_window(app: &tauri::App) -> tauri::Result<()> {
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "island",
        tauri::WebviewUrl::App("island.html".into()),
    )
    .title("ClickFlow Island")
    .inner_size(ISLAND_W, ISLAND_H)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .focused(false)
    .visible(false)
    .build()?;

    // 纯展示，不拦截鼠标
    let _ = window.set_ignore_cursor_events(true);
    Ok(())
}

/// 查找 eIsland 默认岛窗口（标题 "eIsland"，一条细长条），返回其屏幕矩形
#[cfg(windows)]
fn eisland_island_rect() -> Option<(i32, i32, i32, i32)> {
    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> *mut core::ffi::c_void;
        fn GetWindowRect(hwnd: *mut core::ffi::c_void, rect: *mut Rect) -> i32;
        fn IsWindowVisible(hwnd: *mut core::ffi::c_void) -> i32;
    }
    let title: Vec<u16> = "eIsland\0".encode_utf16().collect();
    let hwnd = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
    if hwnd.is_null() || unsafe { IsWindowVisible(hwnd) } == 0 {
        return None;
    }
    let mut rect = Rect {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return None;
    }
    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;
    // 只认顶部那条细长岛，过滤掉设置主窗口
    if h < 30 || h > 140 || w < 120 || rect.top > 300 {
        return None;
    }
    Some((rect.left, rect.top, rect.right, rect.bottom))
}

#[cfg(not(windows))]
fn eisland_island_rect() -> Option<(i32, i32, i32, i32)> {
    None
}

/// 按设置把胶囊摆到指定角落 / 顶部居中（物理像素，避开任务栏）
fn position_island(app: &AppHandle, position: &str) {
    let Some(window) = app.get_webview_window("island") else {
        return;
    };
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let (wl, wt, wr, wb) = work_area().unwrap_or_else(|| {
        let size = monitor.size();
        (0, 0, size.width as i32, size.height as i32)
    });
    let monitor_pos = monitor.position();
    let monitor_w = monitor.size().width as i32;
    let pw = (ISLAND_W * scale).round() as i32;
    let ph = (ISLAND_H * scale).round() as i32;
    let margin = (16.0 * scale).round() as i32;
    let (x, y) = match position {
        "topLeft" => (wl + margin, wt + margin),
        "topRight" => (wr - pw - margin, wt + margin),
        "bottomLeft" => (wl + margin, wb - ph - margin),
        "bottomRight" => (wr - pw - margin, wb - ph - margin),
        // 中上：优先对齐 eIsland 默认岛（跟着它走），找不到就落在屏幕顶部居中
        _ => match eisland_island_rect() {
            Some((el, et, er, _eb)) => ((el + er - pw) / 2, et),
            None => (monitor_pos.x + (monitor_w - pw) / 2, wt),
        },
    };
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        handle_hotkey(app, shortcut);
                    }
                })
                .build(),
        )
        .manage(Shared::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let loaded = load_settings(&handle);
            {
                let state = handle.state::<Shared>();
                let mut guard = state
                    .settings
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                *guard = loaded.clone();
            }
            if let Err(err) = apply_hotkeys(&handle, &loaded) {
                eprintln!("[ClickFlow] {err}");
            }
            mouse::boost_timer();
            spawn_mouse_hook(handle.clone());
            if let Err(err) = create_island_window(app) {
                eprintln!("[ClickFlow] 灵动岛窗口创建失败: {err}");
            }
            position_island(&handle, &loaded.island_position);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                RUNNING.store(false, Ordering::SeqCst);
                mouse::restore_timer();
                // 主窗口关闭即退出；否则隐藏的灵动岛窗口会让进程留在后台
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            toggle_clicker,
            start_clicker,
            stop_clicker,
            clicker_status,
            hotkey_error,
            pause_hotkeys
        ])
        .run(tauri::generate_context!())
        .expect("ClickFlow 启动失败");
}
