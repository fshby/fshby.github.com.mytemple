// global_capture.rs — 全局快捷键触发的屏幕捕获（xcap 原生 GDI/DXGI，零弹窗）
//
// 设计：
//   Alt+A → xcap 抓主显示器全屏 PNG → base64 → 创建独立透明全屏窗口
//         → 前端区域框选 + 标注 → screenshot_result IPC → 窗口销毁
//   Alt+M → 同上独立窗口 → 区域框选 → 原生 DXGI 录屏 → WebM 保存
//
// 关键原则：截图/录屏全过程不触碰主窗口（不 show、不 focus、不 emit 到 main）

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::sync::mpsc::Receiver;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

/// 全局录屏状态（VideoRecorder + 帧接收器保持存活直到 stop）
struct RecordState {
    recorder: xcap::VideoRecorder,
    frame_rx: Receiver<xcap::Frame>,
}

static RECORD_STATE: std::sync::OnceLock<Mutex<Option<RecordState>>> = std::sync::OnceLock::new();

fn record_state() -> &'static Mutex<Option<RecordState>> {
    RECORD_STATE.get_or_init(|| Mutex::new(None))
}

// ── 原子锁：防止并发截图/录屏操作（比时间戳节流更可靠） ──
static SCREENSHOT_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static RECORD_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

// ── 锁获取时间：用于超时恢复（防止锁卡死后永久阻塞） ──
static SCREENSHOT_LOCK_TIME: std::sync::OnceLock<Mutex<Option<Instant>>> = std::sync::OnceLock::new();
static RECORD_LOCK_TIME: std::sync::OnceLock<Mutex<Option<Instant>>> = std::sync::OnceLock::new();

fn screenshot_lock_time() -> &'static Mutex<Option<Instant>> {
    SCREENSHOT_LOCK_TIME.get_or_init(|| Mutex::new(None))
}

fn record_lock_time() -> &'static Mutex<Option<Instant>> {
    RECORD_LOCK_TIME.get_or_init(|| Mutex::new(None))
}

/// 锁超时阈值：30 秒后强制释放（防止窗口加载失败/前端 JS 错误导致锁永久卡死）
const LOCK_TIMEOUT_SECS: u64 = 30;

/// 尝试获取截图锁，带超时检查
fn try_acquire_screenshot_lock() -> bool {
    // 先检查是否有卡死的锁（超过 30 秒），如果有则强制释放
    if SCREENSHOT_IN_PROGRESS.load(Ordering::SeqCst) {
        let should_force_release = {
            match screenshot_lock_time().lock() {
                Ok(guard) => {
                    if let Some(t) = *guard {
                        t.elapsed().as_secs() >= LOCK_TIMEOUT_SECS
                    } else {
                        // 锁为 true 但时间为 None：状态不一致，强制释放
                        true
                    }
                }
                Err(_) => false,
            }
        };
        if should_force_release {
            log::warn!("[screenshot] 检测到锁卡死超过 {} 秒，强制释放", LOCK_TIMEOUT_SECS);
            SCREENSHOT_IN_PROGRESS.store(false, Ordering::SeqCst);
            if let Ok(mut g) = screenshot_lock_time().lock() {
                *g = None;
            }
        }
    }
    // CAS 获取锁
    if SCREENSHOT_IN_PROGRESS.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return false;
    }
    // 记录获取时间
    if let Ok(mut g) = screenshot_lock_time().lock() {
        *g = Some(Instant::now());
    }
    true
}

/// 释放截图锁
fn release_screenshot_lock() {
    SCREENSHOT_IN_PROGRESS.store(false, Ordering::SeqCst);
    if let Ok(mut g) = screenshot_lock_time().lock() {
        *g = None;
    }
}

/// 尝试获取录屏锁，带超时检查
fn try_acquire_record_lock() -> bool {
    if RECORD_IN_PROGRESS.load(Ordering::SeqCst) {
        let should_force_release = {
            match record_lock_time().lock() {
                Ok(guard) => {
                    if let Some(t) = *guard {
                        t.elapsed().as_secs() >= LOCK_TIMEOUT_SECS
                    } else {
                        true
                    }
                }
                Err(_) => false,
            }
        };
        if should_force_release {
            log::warn!("[recorder] 检测到锁卡死超过 {} 秒，强制释放", LOCK_TIMEOUT_SECS);
            RECORD_IN_PROGRESS.store(false, Ordering::SeqCst);
            if let Ok(mut g) = record_lock_time().lock() {
                *g = None;
            }
        }
    }
    if RECORD_IN_PROGRESS.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return false;
    }
    if let Ok(mut g) = record_lock_time().lock() {
        *g = Some(Instant::now());
    }
    true
}

/// 释放录屏锁
fn release_record_lock() {
    RECORD_IN_PROGRESS.store(false, Ordering::SeqCst);
    if let Ok(mut g) = record_lock_time().lock() {
        *g = None;
    }
}

// ── 截图/录屏触发去重：global-shortcut 与 JS keydown 可能同时触发同一操作
static LAST_SCREENSHOT_AT: std::sync::OnceLock<std::sync::Mutex<std::time::Instant>> = std::sync::OnceLock::new();
static LAST_RECORD_AT: std::sync::OnceLock<std::sync::Mutex<std::time::Instant>> = std::sync::OnceLock::new();

fn throttle_screenshot() -> bool {
    let last = LAST_SCREENSHOT_AT.get_or_init(|| std::sync::Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(1)));
    let mut guard = last.lock().unwrap();
    let now = std::time::Instant::now();
    if now.duration_since(*guard) < std::time::Duration::from_millis(800) {
        return false;
    }
    *guard = now;
    true
}

fn throttle_record() -> bool {
    let last = LAST_RECORD_AT.get_or_init(|| std::sync::Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(1)));
    let mut guard = last.lock().unwrap();
    let now = std::time::Instant::now();
    if now.duration_since(*guard) < std::time::Duration::from_millis(800) {
        return false;
    }
    *guard = now;
    true
}

// ── 待截图数据暂存：截图窗口就绪后通过事件发送 ──
static PENDING_SCREENSHOT: std::sync::OnceLock<Mutex<Option<PendingScreenshot>>> = std::sync::OnceLock::new();

struct PendingScreenshot {
    file_path: String,
    width: u32,
    height: u32,
    version: u64,  // 版本号，前端轮询检测新截图
}

fn pending_screenshot() -> &'static Mutex<Option<PendingScreenshot>> {
    PENDING_SCREENSHOT.get_or_init(|| Mutex::new(None))
}

// ── 待录屏背景帧暂存 ──
static PENDING_RECORD_BG: std::sync::OnceLock<Mutex<Option<RecordBg>>> = std::sync::OnceLock::new();

struct RecordBg {
    file_path: String,
    width: u32,
    height: u32,
}

fn pending_record_bg() -> &'static Mutex<Option<RecordBg>> {
    PENDING_RECORD_BG.get_or_init(|| Mutex::new(None))
}

// ── 截图版本号计数器（前端轮询检测新截图） ──
static SCREENSHOT_VERSION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn get_screenshot_version() -> u64 {
    SCREENSHOT_VERSION.load(Ordering::SeqCst)
}

fn bump_screenshot_version() {
    SCREENSHOT_VERSION.fetch_add(1, Ordering::SeqCst);
}

// ── 前端心跳：检测截图窗口是否还活着（防止卡死） ──
static LAST_HEARTBEAT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn heartbeat_screenshot() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    LAST_HEARTBEAT.store(now, Ordering::SeqCst);
}

pub fn get_last_heartbeat() -> u64 {
    LAST_HEARTBEAT.load(Ordering::SeqCst)
}

// ── 闲置延迟销毁定时器（内存优化）：窗口隐藏后 60 秒未再次使用则彻底销毁 ──
// 设计：对标微信"按快捷键毫秒级响应"，但避免隐藏窗口长期常驻内存
//   - 关闭时立即隐藏+移出屏幕（保持视觉消失）
//   - 启动 60 秒延迟销毁线程，到期 destroy() 释放 WebView2 资源
//   - 再次触发 show 时取消挂起的销毁定时器，复用窗口
//   - 用户连续截图/录屏（< 60 秒间隔）走复用路径，无延迟
//   - 长时间不用自动销毁，释放约 29 MB 常驻内存（截图 25.8 MB + 录屏 3.5 MB）
const WINDOW_DESTROY_DELAY_SECS: u64 = 60;

static SCREENSHOT_DESTROY_TIMER: std::sync::OnceLock<std::sync::Mutex<Option<std::thread::JoinHandle<()>>>> = std::sync::OnceLock::new();
static RECORDER_DESTROY_TIMER: std::sync::OnceLock<std::sync::Mutex<Option<std::thread::JoinHandle<()>>>> = std::sync::OnceLock::new();

fn screenshot_destroy_timer() -> &'static std::sync::Mutex<Option<std::thread::JoinHandle<()>>> {
    SCREENSHOT_DESTROY_TIMER.get_or_init(|| std::sync::Mutex::new(None))
}

fn recorder_destroy_timer() -> &'static std::sync::Mutex<Option<std::thread::JoinHandle<()>>> {
    RECORDER_DESTROY_TIMER.get_or_init(|| std::sync::Mutex::new(None))
}

/// 取消挂起的截图窗口销毁定时器（show 时调用，复用窗口）
fn cancel_screenshot_destroy_timer() {
    if let Ok(mut guard) = screenshot_destroy_timer().lock() {
        if let Some(handle) = guard.take() {
            // JoinHandle 没有 cancel 方法，只能让线程自然到期销毁窗口；
            // 但窗口已被 show 唤醒并复用，到期 destroy 时会 destroy 一个仍在使用的窗口——
            // 这里用 atomic flag 取代 cancel：destroy 线程先检查 SCREENSHOT_IN_PROGRESS
            // 已在 show_xxx 中重新获取锁，destroy 线程发现锁被持有就放弃销毁。
            // 安全清理句柄让旧线程失去对外的引用（线程会自然结束）。
            // 关键：线程内的销毁动作依赖 SCREENSHOT_IN_PROGRESS 状态判断
            drop(handle);
        }
    }
}

fn cancel_recorder_destroy_timer() {
    if let Ok(mut guard) = recorder_destroy_timer().lock() {
        if let Some(handle) = guard.take() {
            drop(handle);
        }
    }
}

/// 启动截图窗口延迟销毁（关闭时调用）
fn schedule_screenshot_destroy(app: &AppHandle) {
    cancel_screenshot_destroy_timer();
    let app_clone = app.clone();
    let handle = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(WINDOW_DESTROY_DELAY_SECS));
        use tauri::Manager as _;
        // 双重校验：定时器期间用户可能再次触发截图，此时窗口已 show 且锁已获取
        // 只有窗口存在且不可见（即仍处于隐藏闲置状态）才销毁
        if let Ok(_guard) = screenshot_destroy_timer().lock() {
            // 如果句柄已被 take（cancel 调用过），说明用户已重新使用，放弃销毁
        }
        if let Some(win) = app_clone.get_webview_window("screenshot") {
            let is_visible = win.is_visible().unwrap_or(false);
            // 关键：只有窗口仍隐藏（即未被再次 show）才销毁
            if !is_visible && !SCREENSHOT_IN_PROGRESS.load(Ordering::SeqCst) {
                log::info!("[screenshot-window] 闲置 {} 秒，自动销毁释放内存", WINDOW_DESTROY_DELAY_SECS);
                let _ = win.destroy();
            }
        }
    });
    if let Ok(mut guard) = screenshot_destroy_timer().lock() {
        *guard = Some(handle);
    }
}

fn schedule_recorder_destroy(app: &AppHandle) {
    cancel_recorder_destroy_timer();
    let app_clone = app.clone();
    let handle = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(WINDOW_DESTROY_DELAY_SECS));
        use tauri::Manager as _;
        if let Some(win) = app_clone.get_webview_window("recorder") {
            let is_visible = win.is_visible().unwrap_or(false);
            if !is_visible && !RECORD_IN_PROGRESS.load(Ordering::SeqCst) {
                log::info!("[recorder-window] 闲置 {} 秒，自动销毁释放内存", WINDOW_DESTROY_DELAY_SECS);
                let _ = win.destroy();
            }
        }
    });
    if let Ok(mut guard) = recorder_destroy_timer().lock() {
        *guard = Some(handle);
    }
}

// ── 全局截图入口 ────────────────────────────────────────

pub fn trigger_screenshot(app: AppHandle) {
    if !throttle_screenshot() { return; }
    use tauri::Manager as _;

    // 安全开关：如果截图窗口已经可见，按 Alt+A 直接关闭（防止用户卡住无法退出）
    if let Some(win) = app.get_webview_window("screenshot") {
        if win.is_visible().unwrap_or(false) {
            log::info!("[screenshot] 截图窗口已显示，按 Alt+A 切换关闭");
            close_screenshot_window(&app);
            return;
        }
    }

    // 原子锁：防止并发截图（连续按 Alt+A 或快捷键+JS 同时触发）
    if !try_acquire_screenshot_lock() {
        log::info!("[screenshot] 截图正在进行中，跳过本次触发");
        return;
    }

    // 立即截图，不最小化窗口，不调起主窗口——用独立的透明截图窗口显示 overlay
    let (png_bytes, width, height) = match capture_primary_display_png() {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[global-capture] 屏幕捕获失败: {}", e);
            // 通知主窗口显示错误提示
            let _ = app.emit("screenshot-error", serde_json::json!({ "error": e }));
            release_screenshot_lock();
            return;
        }
    };

    let b64 = base64_encode(&png_bytes);
    let _data_url = format!("data:image/png;base64,{}", b64);

    // 写入临时文件（避免通过 IPC 传递多 MB base64 字符串，WebView2 可能静默丢弃）
    let temp_path = std::env::temp_dir().join(format!("mt_screenshot_{}.png", std::process::id()));
    match std::fs::write(&temp_path, &png_bytes) {
        Ok(_) => {
            log::info!("[screenshot] 截图已写入临时文件: {} ({}KB)", temp_path.display(), png_bytes.len() / 1024);
        }
        Err(e) => {
            log::error!("[screenshot] 写入临时文件失败: {}", e);
            let _ = app.emit("screenshot-error", serde_json::json!({ "error": format!("写入临时文件失败: {}", e) }));
            release_screenshot_lock();
            return;
        }
    }

    // 暂存截图数据（只传文件路径，不传 base64），并更新版本号
    {
        let mut guard = pending_screenshot().lock().unwrap();
        bump_screenshot_version();
        *guard = Some(PendingScreenshot {
            file_path: temp_path.to_string_lossy().to_string(),
            width,
            height,
            version: get_screenshot_version(),
        });
    }

    // 显示截图窗口（复用已有窗口，毫秒级响应；首次创建则预创建）
    show_screenshot_window(&app);
}

/// 预创建截图/录屏窗口（应用启动时调用，隐藏状态，页面预加载）
/// 对标微信：软件启动时截图窗口就已就绪，按快捷键只做 show
/// 关键：不用 fullscreen 模式（透明+全屏组合在集显上容易卡死），改用无边框窗口+手动覆盖屏幕
pub fn precreate_windows(app: &AppHandle, port: u16) {
    use tauri::Manager as _;

    // 获取主显示器尺寸（用于手动覆盖屏幕，替代 fullscreen）
    let (mon_w, mon_h) = match app.primary_monitor() {
        Ok(Some(mon)) => {
            let size = mon.size();
            (size.width as f64, size.height as f64)
        }
        _ => (1920.0, 1080.0), // 兜底
    };
    log::info!("[screenshot-window] 主显示器尺寸: {}x{}", mon_w, mon_h);

    // 预创建截图窗口
    if app.get_webview_window("screenshot").is_none() {
        let url = format!("http://127.0.0.1:{}/screenshot.html?v=20260920", port);
        if let Ok(url_parsed) = url::Url::parse(&url) {
            match tauri::WebviewWindowBuilder::new(
                app,
                "screenshot",
                tauri::WebviewUrl::External(url_parsed),
            )
                .title("截图")
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .resizable(false)
                .skip_taskbar(true)
                .visible(false)
                .inner_size(mon_w, mon_h)
                // 预创建时放在屏幕外（避免启动时闪烁/残留，集显上透明窗口初始化可能有渲染残留）
                // show 的时候再移回 (0,0)
                .position(-10000.0, -10000.0)
                .build()
            {
                Ok(_) => log::info!("[screenshot-window] 截图窗口预创建成功 (屏幕外预创建，无边框+手动覆盖，更稳定)"),
                Err(e) => log::warn!("[screenshot-window] 截图窗口预创建失败: {}", e),
            }
        }
    }

    // 预创建录屏窗口
    if app.get_webview_window("recorder").is_none() {
        let url = format!("http://127.0.0.1:{}/recorder.html", port);
        if let Ok(url_parsed) = url::Url::parse(&url) {
            match tauri::WebviewWindowBuilder::new(
                app,
                "recorder",
                tauri::WebviewUrl::External(url_parsed),
            )
                .title("录屏")
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .resizable(false)
                .skip_taskbar(true)
                .visible(false)
                .inner_size(mon_w, mon_h)
                .position(-10000.0, -10000.0)
                .build()
            {
                Ok(_) => log::info!("[recorder-window] 录屏窗口预创建成功 (屏幕外预创建，无边框+手动覆盖，更稳定)"),
                Err(e) => log::warn!("[recorder-window] 录屏窗口预创建失败: {}", e),
            }
        }
    }

    // 启动截图窗口健康监控线程：窗口可见但 15 秒无心跳 → 强制关闭（终极防卡死）
    let app_clone = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let win = match app_clone.get_webview_window("screenshot") {
                Some(w) => w,
                None => continue,
            };
            let is_visible = win.is_visible().unwrap_or(false);
            if !is_visible { continue; }

            // 窗口可见，检查心跳
            let last = get_last_heartbeat();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let diff = now.saturating_sub(last);
            if diff > 15 && last > 0 {
                log::error!("[screenshot-monitor] 截图窗口 {} 秒无心跳，疑似卡死，强制关闭！", diff);
                close_screenshot_window(&app_clone);
            }
        }
    });
}

/// 显示/创建截图窗口（无边框、透明、置顶、手动覆盖屏幕）
/// 优化：复用已有窗口，避免每次重建 WebView2（重建需要几百毫秒到 1 秒）
/// 关键：不用 fullscreen 模式（透明+全屏组合在集显上容易卡死）
fn show_screenshot_window(app: &AppHandle) {
    use tauri::Manager as _;

    // 如果窗口已存在，直接显示（毫秒级响应）
    if let Some(win) = app.get_webview_window("screenshot") {
        log::info!("[screenshot-window] 复用已有截图窗口");
        // 恢复窗口状态（关闭时做了多重保险，打开时要全部恢复）
        let _ = win.set_always_on_top(true);
        let _ = win.unminimize();
        // 确保窗口大小覆盖屏幕（每次 show 都重新设置，防止 DPI 变化）
        if let Ok(Some(mon)) = app.primary_monitor() {
            let size = mon.size();
            let _ = win.set_size(tauri::PhysicalSize::new(size.width, size.height));
            let _ = win.set_position(tauri::PhysicalPosition::new(0, 0));
        }
        let _ = win.show();
        let _ = win.set_focus();
        // 5 分钟超时保护（用户可能长时间编辑标注，不能太短）
        let app_clone = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(300));
            if let Some(w) = app_clone.get_webview_window("screenshot") {
                let is_visible = w.is_visible().unwrap_or(false);
                if (is_visible) {
                    log::warn!("[screenshot-window] 截图超时 5 分钟，自动关闭");
                    crate::global_capture::close_screenshot_window(&app_clone);
                }
            }
        });
        return;
    }

    // 首次创建窗口（兜底：预创建失败时走这里）
    let port = crate::SERVER_PORT.get().copied().unwrap_or(7321);
    let (mon_w, mon_h) = match app.primary_monitor() {
        Ok(Some(mon)) => {
            let size = mon.size();
            (size.width as f64, size.height as f64)
        }
        _ => (1920.0, 1080.0),
    };
    let url = format!("http://127.0.0.1:{}/screenshot.html", port);
    let url_parsed = match url::Url::parse(&url) {
        Ok(u) => u,
        Err(e) => {
            log::warn!("[screenshot-window] URL 解析失败: {}", e);
            release_screenshot_lock();
            if let Ok(mut guard) = pending_screenshot().lock() {
                if let Some(p) = guard.take() {
                    let _ = std::fs::remove_file(&p.file_path);
                }
            }
            return;
        }
    };

    let result = tauri::WebviewWindowBuilder::new(
        app,
        "screenshot",
        tauri::WebviewUrl::External(url_parsed),
    )
        .title("截图")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .inner_size(mon_w, mon_h)
        .position(0.0, 0.0)
        .build();

    match result {
        Ok(win) => {
            log::info!("[screenshot-window] 截图窗口创建成功");

            // 首次创建：等待前端加载完成后由前端调用 ready 显示
            // 30 秒超时监控
            let app_clone = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(30));
                if let Some(w) = app_clone.get_webview_window("screenshot") {
                    let is_visible = w.is_visible().unwrap_or(false);
                    if !is_visible {
                        log::warn!("[screenshot-window] 窗口 30 秒内未就绪，自动清理");
                        let _ = w.destroy();
                        release_screenshot_lock();
                        if let Ok(mut guard) = pending_screenshot().lock() {
                            if let Some(p) = guard.take() {
                                let _ = std::fs::remove_file(&p.file_path);
                            }
                        }
                        let _ = app_clone.emit("screenshot-error", serde_json::json!({
                            "error": "截图窗口加载超时，请重试"
                        }));
                    }
                }
            });
        }
        Err(e) => {
            log::error!("[screenshot-window] 创建截图窗口失败: {} — 不调起主窗口，放弃本次截图", e);
            release_screenshot_lock();
            if let Ok(mut guard) = pending_screenshot().lock() {
                if let Some(p) = guard.take() {
                    let _ = std::fs::remove_file(&p.file_path);
                }
            }
        }
    }
}

/// 截图窗口已就绪（前端图片已加载完成），显示窗口
pub fn on_screenshot_window_ready(app: &AppHandle) {
    use tauri::Manager as _;
    // 安全检查：只有当有待处理的截图数据时才显示窗口（防止窗口误显示挡住屏幕）
    let has_pending = match pending_screenshot().lock() {
        Ok(guard) => guard.is_some(),
        Err(_) => false,
    };
    if !has_pending {
        log::warn!("[screenshot] ready 信号但无待处理截图数据，不显示窗口");
        return;
    }
    if let Some(win) = app.get_webview_window("screenshot") {
        let _ = win.show();
        let _ = win.set_focus();
        log::info!("[screenshot] 窗口已显示");
    }
}

/// HTTP GET /api/screenshot/bg 调用：读取临时文件返回 PNG 字节
pub fn get_pending_screenshot_bytes() -> Option<Vec<u8>> {
    let path = {
        match pending_screenshot().lock() {
            Ok(guard) => guard.as_ref().map(|p| p.file_path.clone()),
            Err(_) => None,
        }
    };
    let path = path?;
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(e) => {
            log::error!("[screenshot] 读取临时文件失败: {} — {}", path, e);
            None
        }
    }
}

/// HTTP 轮询降级：获取 pending_screenshot 数据（只读，不消费）
pub fn try_get_pending_screenshot() -> Option<serde_json::Value> {
    if let Ok(guard) = pending_screenshot().lock() {
        if let Some(p) = guard.as_ref() {
            return Some(serde_json::json!({
                "filePath": p.file_path,
                "width": p.width,
                "height": p.height,
            }));
        }
    }
    None
}

/// 关闭截图窗口（隐藏而非销毁，复用窗口提升后续截图响应速度）
pub fn close_screenshot_window(app: &AppHandle) {
    use tauri::Manager as _;
    // 先清理状态（最优先，确保后续截图能正常触发）
    release_screenshot_lock();
    // 清理临时文件
    if let Ok(mut guard) = pending_screenshot().lock() {
        if let Some(p) = guard.take() {
            let _ = std::fs::remove_file(&p.file_path);
        }
    }
    // 多重保险确保窗口消失：取消置顶 → 最小化 → 隐藏 → 移出屏幕
    if let Some(win) = app.get_webview_window("screenshot") {
        // 1. 取消置顶（防止挡住其他窗口）
        let _ = win.set_always_on_top(false);
        // 2. 最小化（最可靠的"消失"方式）
        let _ = win.minimize();
        // 3. 隐藏
        let _ = win.hide();
        // 4. 移动到屏幕外（终极兜底）
        let _ = win.set_position(tauri::PhysicalPosition::new(-10000, -10000));
        log::info!("[screenshot-window] 截图窗口已关闭（多重保险）");
    }
}

/// 处理截图结果（复制到剪贴板/保存文件）
pub fn handle_screenshot_result(app: &AppHandle, image_base64: String, action: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(&image_base64)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let default_name = format!("screenshot_{}.png", ts);

    // 无论什么 action，都复制到剪贴板（对标微信截图：保存时也复制）
    match copy_image_to_clipboard(&bytes) {
        Ok(_) => { log::info!("[screenshot] 已复制到剪贴板"); }
        Err(e) => { log::warn!("[screenshot] 复制到剪贴板失败: {}", e); }
    }

    // action=save 或 both 时，额外保存到文件
    if action == "save" || action == "both" {
        let save_dir = std::env::var("USERPROFILE")
            .map(|p| std::path::PathBuf::from(p).join("Pictures"))
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        let _ = std::fs::create_dir_all(&save_dir);
        let path = save_dir.join(&default_name);
        match std::fs::write(&path, &bytes) {
            Ok(_) => { log::info!("[screenshot] 已保存到: {}", path.display()); }
            Err(e) => { log::warn!("[screenshot] 保存失败: {}", e); }
        }
    }

    Ok(())
}

fn copy_image_to_clipboard(png_bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let temp_path = std::env::temp_dir().join(format!("mt_clip_{}.png", uuid::Uuid::new_v4()));
    std::fs::write(&temp_path, png_bytes).map_err(|e| format!("写入临时文件失败: {}", e))?;

    // PowerShell 脚本：加 try-catch 和即时退出，防卡死
    let ps_script = format!(
        "try {{ Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('{}'); [System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose() }} catch {{ exit 1 }}",
        temp_path.display()
    );

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps_script]);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    // 用 spawn + try_wait 轮询，加 5 秒超时防卡死
    // PowerShell 首次加载 .NET 程序集可能较慢，但不应超过 5 秒
    let mut child = cmd.spawn().map_err(|e| format!("启动 PowerShell 失败: {}", e))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    log::warn!("[screenshot] PowerShell 剪贴板操作超时 5s，已杀进程");
                    let _ = std::fs::remove_file(&temp_path);
                    return Err("PowerShell 剪贴板操作超时".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("等待 PowerShell 完成: {}", e));
            }
        }
    };

    let _ = std::fs::remove_file(&temp_path);

    if status.success() {
        Ok(())
    } else {
        Err(format!("剪贴板设置失败 (exit {})", status.code().unwrap_or(-1)))
    }
}

/// 截图并返回数据（HTTP 模式下使用，不依赖 Tauri 事件）
/// 不调起主窗口，不创建独立窗口——前端自行处理显示
pub fn capture_screenshot_data(app: &AppHandle) -> Result<serde_json::Value, String> {
    if !throttle_screenshot() {
        return Err("截图正在处理中，请稍候".to_string());
    }

    // 原子锁
    if !try_acquire_screenshot_lock() {
        return Err("截图正在进行中".to_string());
    }

    let (png_bytes, width, height) = match capture_primary_display_png() {
        Ok(v) => v,
        Err(e) => {
            release_screenshot_lock();
            return Err(format!("屏幕捕获失败: {}", e));
        }
    };

    // 写入临时文件，返回文件路径（HTTP 模式也用文件路径，避免超大 JSON 响应）
    let temp_path = std::env::temp_dir().join(format!("mt_screenshot_http_{}.png", std::process::id()));
    std::fs::write(&temp_path, &png_bytes)
        .map_err(|e| {
            release_screenshot_lock();
            format!("写入临时文件失败: {}", e)
        })?;

    // HTTP 模式下立即释放锁（前端自行管理截图生命周期）
    release_screenshot_lock();

    Ok(serde_json::json!({
        "filePath": temp_path.to_string_lossy().to_string(),
        "width": width,
        "height": height,
    }))
}

/// 全局录屏入口：创建独立录屏窗口（不调起主窗口）
pub fn trigger_record(app: AppHandle) {
    if !throttle_record() { return; }
    use tauri::Manager as _;

    // 安全开关：如果录屏窗口已经可见
    if let Some(win) = app.get_webview_window("recorder") {
        if win.is_visible().unwrap_or(false) {
            // 如果正在录制中，通知前端停止录制（弹出保存对话框），而非直接关闭窗口丢失录屏
            if RECORD_IN_PROGRESS.load(Ordering::SeqCst) {
                log::info!("[recorder] 录制中，通知前端停止录制");
                let _ = win.emit("recorder-stop-request", ());
                return;
            }
            log::info!("[recorder] 录屏窗口已显示，按 Alt+M 切换关闭");
            close_recorder_window(&app);
            return;
        }
    }

    // 原子锁：防止并发录屏
    if !try_acquire_record_lock() {
        log::info!("[recorder] 录屏正在进行中，跳过本次触发");
        return;
    }

    // 先截一帧作为选区背景（让用户在透明窗口上看到遮罩效果）
    let (png_bytes, width, height) = match capture_primary_display_png() {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[recorder] 截取背景帧失败: {}", e);
            let _ = app.emit("screenshot-error", serde_json::json!({ "error": format!("录屏背景帧捕获失败: {}", e) }));
            release_record_lock();
            return;
        }
    };

    // 写入临时文件
    let temp_path = std::env::temp_dir().join(format!("mt_record_bg_{}.png", std::process::id()));
    match std::fs::write(&temp_path, &png_bytes) {
        Ok(_) => {
            log::info!("[recorder] 背景帧已写入临时文件: {} ({}KB)", temp_path.display(), png_bytes.len() / 1024);
        }
        Err(e) => {
            log::error!("[recorder] 写入背景帧临时文件失败: {}", e);
            let _ = app.emit("screenshot-error", serde_json::json!({ "error": format!("写入背景帧文件失败: {}", e) }));
            release_record_lock();
            return;
        }
    }

    // 暂存背景帧路径
    {
        let mut guard = pending_record_bg().lock().unwrap();
        *guard = Some(RecordBg {
            file_path: temp_path.to_string_lossy().to_string(),
            width,
            height,
        });
    }

    show_recorder_window(&app);
}

/// 显示/创建录屏窗口（独立的无边框透明全屏窗口）
fn show_recorder_window(app: &AppHandle) {
    use tauri::Manager as _;

    // 如果窗口已存在，直接显示（毫秒级响应）
    if let Some(win) = app.get_webview_window("recorder") {
        log::info!("[recorder-window] 复用已有录屏窗口");
        let _ = win.set_always_on_top(true);
        let _ = win.set_ignore_cursor_events(false); // 恢复鼠标捕获（选区阶段需要）
        let _ = win.unminimize();
        // 确保窗口大小覆盖屏幕
        if let Ok(Some(mon)) = app.primary_monitor() {
            let size = mon.size();
            let _ = win.set_size(tauri::PhysicalSize::new(size.width, size.height));
            let _ = win.set_position(tauri::PhysicalPosition::new(0, 0));
        }
        // 关键修复：复用窗口时必须重新加载页面，重置前端 JS 状态。
        // 不 reload 会导致：上次录屏的 recording=true/recorder/chunks/region 等变量残留，
        // init() 不再执行，DOM 已被清空 → 用户看到空白窗口无法操作；
        // 或 api_start_native_record 因前端状态错乱失败 → 降级 getDisplayMedia 弹桌面选择器。
        let port = crate::SERVER_PORT.get().copied().unwrap_or(7321);
        let reload_url = format!("http://127.0.0.1:{}/recorder.html?_t={}", port, std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
        let _ = win.eval(&format!("window.location.href='{}';", reload_url));
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    // 首次创建窗口
    let port = crate::SERVER_PORT.get().copied().unwrap_or(7321);
    let (mon_w, mon_h) = match app.primary_monitor() {
        Ok(Some(mon)) => {
            let size = mon.size();
            (size.width as f64, size.height as f64)
        }
        _ => (1920.0, 1080.0),
    };
    let url = format!("http://127.0.0.1:{}/recorder.html", port);
    let url_parsed = match url::Url::parse(&url) {
        Ok(u) => u,
        Err(e) => {
            log::warn!("[recorder-window] URL 解析失败: {}", e);
            release_record_lock();
            if let Ok(mut guard) = pending_record_bg().lock() {
                if let Some(bg) = guard.take() {
                    let _ = std::fs::remove_file(&bg.file_path);
                }
            }
            return;
        }
    };

    let result = tauri::WebviewWindowBuilder::new(
        app,
        "recorder",
        tauri::WebviewUrl::External(url_parsed),
    )
        .title("录屏")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .inner_size(mon_w, mon_h)
        .position(-10000.0, -10000.0)
        .build();

    match result {
        Ok(_) => {
            log::info!("[recorder-window] 录屏窗口创建成功");

            // 超时监控：30 秒内前端未就绪则自动清理
            let app_clone = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(30));
                if let Some(w) = app_clone.get_webview_window("recorder") {
                    let is_visible = w.is_visible().unwrap_or(false);
                    if !is_visible {
                        log::warn!("[recorder-window] 窗口 30 秒内未就绪，自动清理");
                        let _ = w.destroy();
                        release_record_lock();
                        if let Ok(mut guard) = pending_record_bg().lock() {
                            if let Some(bg) = guard.take() {
                                let _ = std::fs::remove_file(&bg.file_path);
                            }
                        }
                        let _ = app_clone.emit("screenshot-error", serde_json::json!({
                            "error": "录屏窗口加载超时，请重试"
                        }));
                    }
                }
            });
        }
        Err(e) => {
            log::error!("[recorder-window] 创建录屏窗口失败: {} — 不调起主窗口，放弃本次录屏", e);
            release_record_lock();
            if let Ok(mut guard) = pending_record_bg().lock() {
                if let Some(bg) = guard.take() {
                    let _ = std::fs::remove_file(&bg.file_path);
                }
            }
        }
    }
}

/// 录屏窗口已就绪，发送背景帧并显示窗口
pub fn on_recorder_window_ready(app: &AppHandle) {
    use tauri::Manager as _;
    if let Some(win) = app.get_webview_window("recorder") {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));

            let (file_path, width, height) = {
                match pending_record_bg().lock() {
                    Ok(guard) => {
                        if let Some(bg) = guard.as_ref() {
                            (bg.file_path.clone(), bg.width, bg.height)
                        } else {
                            log::warn!("[recorder] pending_record_bg 为空");
                            return;
                        }
                    }
                    Err(e) => {
                        log::error!("[recorder] pending_record_bg 锁获取失败: {}", e);
                        return;
                    }
                }
            };

            if let Some(w) = app_clone.get_webview_window("recorder") {
                let _ = w.emit("record-bg-data", serde_json::json!({
                    "filePath": file_path,
                    "width": width,
                    "height": height,
                }));
                log::info!("[recorder] 已发送轻量通知: filePath={}x{}", width, height);
            }
        });

        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 关闭录屏窗口（隐藏而非销毁，复用窗口提升后续录屏响应速度）
pub fn close_recorder_window(app: &AppHandle) {
    use tauri::Manager as _;
    // 先停止原生录屏（防御性清理 RecordState）：
    // 关键修复：若用户取消/异常退出时未调用 stop_native_record，RecordState 会残留为 Some，
    // 导致下一次 start_native_record 返回 "录屏已在进行中" → 前端降级到 getDisplayMedia 弹出桌面选择器。
    // 这里作为兜底，确保任何关闭路径都释放原生录屏状态。
    let _ = stop_native_record();
    release_record_lock();
    // 清理临时文件
    if let Ok(mut guard) = pending_record_bg().lock() {
        if let Some(bg) = guard.take() {
            let _ = std::fs::remove_file(&bg.file_path);
        }
    }
    // 多重保险确保窗口消失：取消置顶 → 最小化 → 隐藏 → 移出屏幕
    if let Some(win) = app.get_webview_window("recorder") {
        let _ = win.set_always_on_top(false);
        let _ = win.minimize();
        let _ = win.hide();
        let _ = win.set_position(tauri::PhysicalPosition::new(-10000, -10000));
        // 重置前端页面状态：导航到空白页，下次复用时 show_recorder_window 会 reload 到 recorder.html
        let _ = win.eval("window.location.href='about:blank';");
        log::info!("[recorder-window] 录屏窗口已关闭（多重保险，已清理原生录屏状态，已重置前端页面）");
    }
}

/// 处理录屏结果（保存 WebM 文件，保存成功后清理临时资源）
/// save_path: 可选的自定义保存目录。未提供时回退到 %USERPROFILE%\Videos。
pub fn handle_recorder_result(app: &AppHandle, image_base64: String, _action: String, filename: String, save_path: Option<String>) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(&image_base64)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    // 校验录制内容非空（避免保存空文件）
    if bytes.is_empty() {
        log::warn!("[recorder] 录屏内容为空，跳过保存");
        return Err("录屏内容为空".to_string());
    }

    // 保存目录：优先使用用户自定义目录，否则回退到 %USERPROFILE%\Videos
    let save_dir = match save_path {
        Some(p) if !p.trim().is_empty() => std::path::PathBuf::from(p.trim()),
        _ => std::env::var("USERPROFILE")
            .map(|p| std::path::PathBuf::from(p).join("Videos"))
            .unwrap_or_else(|_| std::path::PathBuf::from(".")),
    };
    let _ = std::fs::create_dir_all(&save_dir);
    let fname = if filename.is_empty() {
        format!("recording_{}.webm", chrono::Local::now().format("%Y%m%d_%H%M%S"))
    } else {
        filename
    };
    let path = save_dir.join(&fname);
    match std::fs::write(&path, &bytes) {
        Ok(_) => {
            log::info!("[recorder] 已保存到: {}", path.display());
            // 保存成功后清理临时资源：停止原生录屏 + 释放锁 + 清理背景帧临时文件
            let _ = stop_native_record();
            release_record_lock();
            if let Ok(mut guard) = pending_record_bg().lock() {
                if let Some(bg) = guard.take() {
                    let _ = std::fs::remove_file(&bg.file_path);
                    log::info!("[recorder] 已清理背景帧临时文件: {}", bg.file_path);
                }
            }
            // 通知主窗口录屏已保存成功
            let _ = app.emit("recorder-saved", serde_json::json!({
                "path": path.to_string_lossy(),
                "filename": fname,
                "size": bytes.len(),
            }));
        }
        Err(e) => {
            log::warn!("[recorder] 保存失败: {}", e);
            // 保存失败也要释放锁和状态，防止卡住
            let _ = stop_native_record();
            release_record_lock();
            return Err(format!("录屏保存失败: {}", e));
        }
    }

    // 窗口销毁由 recorder_result IPC 命令统一处理
    let _ = app;
    Ok(())
}

// ── 录屏 IPC 命令（前端调用 start / stop） ────────────────

/// 开始原生录屏（xcap DXGI Desktop Duplication）
/// 健壮性增强：带重试机制，DXGI 在上次录屏停止后可能需要短暂恢复时间
pub fn start_native_record(app: AppHandle) -> Result<(), String> {
    use xcap::Monitor;

    // 防止重复 start：如果上次录屏的 RecordState 未正确释放，先强制清理
    {
        let mut guard = record_state().lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            // 状态残留：可能是上次 stop_native_record 未正确执行，强制清理
            log::warn!("[global-capture] start_native_record: 检测到 RecordState 残留，强制清理");
            if let Some(state) = guard.take() {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    state.recorder.stop()
                }));
                drop(state.frame_rx);
            }
            // 等待 DXGI 资源释放
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }

    // 重试机制：DXGI Desktop Duplication 在上次停止后可能需要短暂恢复时间
    // 第一次失败可能是 DXGI 资源未完全释放，等待后重试
    let mut last_err = String::new();
    for attempt in 1..=3 {
        if attempt > 1 {
            log::info!("[global-capture] start_native_record 第 {} 次重试（等待 {}ms）", attempt, attempt * 300);
            std::thread::sleep(std::time::Duration::from_millis((attempt * 300) as u64));
        }

        // 获取主显示器
        let monitors = match Monitor::all() {
            Ok(m) => m,
            Err(e) => {
                last_err = format!("Monitor::all: {}", e);
                log::warn!("[global-capture] 第 {} 次尝试 Monitor::all 失败: {}", attempt, e);
                continue;
            }
        };
        let monitor = if let Some(p) = monitors.iter().find(|m| m.is_primary().unwrap_or(false)) {
            p.clone()
        } else {
            match monitors.into_iter().next() {
                Some(m) => m,
                None => {
                    last_err = "无可用显示器".to_string();
                    continue;
                }
            }
        };

        match monitor.video_recorder() {
            Ok((recorder, frame_rx)) => {
                match recorder.start() {
                    Ok(()) => {
                        // 存储状态
                        {
                            let mut guard = record_state().lock().map_err(|e| e.to_string())?;
                            *guard = Some(RecordState { recorder, frame_rx });
                        }

                        let app_clone = app.clone();
                        std::thread::spawn(move || {
                            stream_frames_to_frontend(app_clone);
                        });

                        log::info!("[global-capture] 原生录屏已启动（第 {} 次尝试成功）", attempt);
                        return Ok(());
                    }
                    Err(e) => {
                        last_err = format!("recorder.start: {}", e);
                        log::warn!("[global-capture] 第 {} 次尝试 recorder.start 失败: {}", attempt, e);
                        drop(frame_rx);
                        continue;
                    }
                }
            }
            Err(e) => {
                last_err = format!("video_recorder: {}", e);
                log::warn!("[global-capture] 第 {} 次尝试 video_recorder 失败: {}", attempt, e);
                continue;
            }
        }
    }

    Err(format!("原生录屏启动失败（重试 3 次）: {}", last_err))
}

/// 停止原生录屏
/// 健壮性增强：即使 recorder.stop() 阻塞或出错，也确保 RecordState 被释放，
/// 防止下次 start_native_record 报"录屏已在进行中"导致降级到 getDisplayMedia。
pub fn stop_native_record() -> Result<(), String> {
    let mut guard = record_state().lock().map_err(|e| e.to_string())?;
    if let Some(state) = guard.take() {
        // stop 可能阻塞或出错，用 catch_unwind 防止 panic 卡住锁
        let stop_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            state.recorder.stop()
        }));
        match stop_result {
            Ok(Ok(())) => log::info!("[global-capture] 原生录屏已停止"),
            Ok(Err(e)) => log::warn!("[global-capture] 录屏停止返回错误（状态已释放，不影响下次启动）: {}", e),
            Err(_) => log::warn!("[global-capture] 录屏停止 panic（状态已释放，不影响下次启动）"),
        }
        drop(state.frame_rx); // 让 recv 循环退出
    }
    Ok(())
}

/// 持续从 frame_rx 读帧，编码后 emit 给前端
fn stream_frames_to_frontend(app: AppHandle) {
    let mut last_emit = std::time::Instant::now();
    let min_interval = std::time::Duration::from_millis(50); // ~20fps 上限，降低 CPU 占用

    loop {
        // 用 try_recv 非阻塞读取，然后 sleep 控制帧率
        let frame = {
            let guard = match record_state().lock() {
                Ok(g) => g,
                Err(_) => break,
            };
            match guard.as_ref() {
                Some(s) => match s.frame_rx.try_recv() {
                    Ok(f) => Some(f),
                    Err(std::sync::mpsc::TryRecvError::Empty) => None,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                },
                None => break, // 已被 stop
            }
        };

        if let Some(frame) = frame {
            // 帧率节流：太密则跳过（DXGI 可能推送大量相同帧）
            let now = std::time::Instant::now();
            if now - last_emit < min_interval {
                continue;
            }
            last_emit = now;

            let w = frame.width;
            let h = frame.height;
            // 把 raw RGBA bytes 编码成 PNG（直接用 image crate 的 RgbaImage）
            match encode_rgba_to_png(&frame.raw, w, h) {
                Ok(png) => {
                    let b64 = base64_encode(&png);
                    // 优先发送到录屏窗口，如果不存在则全局 emit（兼容主窗口降级）
                    let _ = app.emit_to(
                        "recorder",
                        "native-record-frame",
                        serde_json::json!({
                            "dataUrl": format!("data:image/png;base64,{}", b64),
                            "width": w,
                            "height": h,
                        }),
                    );
                }
                Err(e) => {
                    log::warn!("[global-capture] 帧编码失败: {}", e);
                }
            }
        } else {
            // 短暂 sleep 避免忙等
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    log::info!("[global-capture] 帧流循环退出");
}

// ── 辅助函数 ────────────────────────────────────────

fn show_focus_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 用 xcap 抓主显示器全屏，编码为 PNG bytes（带重试）
fn capture_primary_display_png() -> Result<(Vec<u8>, u32, u32), String> {
    use xcap::Monitor;
    use image::ImageEncoder;

    let monitors = Monitor::all().map_err(|e| format!("xcap Monitor::all: {}", e))?;
    log::info!("[capture] 发现 {} 个显示器", monitors.len());
    let monitor = if let Some(p) = monitors.iter().find(|m| m.is_primary().unwrap_or(false)) {
        log::info!("[capture] 使用主显示器: {}x{}", p.width().unwrap_or(0), p.height().unwrap_or(0));
        p.clone()
    } else {
        log::warn!("[capture] 未找到主显示器，使用第一个");
        monitors.into_iter().next().ok_or_else(|| "无可用显示器".to_string())?
    };

    // 重试 3 次，每次间隔 100ms（GDI 捕获可能在首次调用时因 DWM 状态未就绪而失败）
    let mut last_err = String::new();
    for attempt in 1..=3 {
        match monitor.capture_image() {
            Ok(img) => {
                let w = img.width();
                let h = img.height();
                log::info!("[capture] 第 {} 次尝试成功: {}x{}", attempt, w, h);

                let mut out: Vec<u8> = Vec::with_capacity((w * h * 4) as usize);
                let encoder = image::codecs::png::PngEncoder::new(&mut out);
                match encoder.write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgba8) {
                    Ok(_) => return Ok((out, w, h)),
                    Err(e) => return Err(format!("PNG 编码失败: {}", e)),
                }
            }
            Err(e) => {
                last_err = format!("xcap capture_image (attempt {}): {}", attempt, e);
                log::warn!("[capture] 第 {} 次捕获失败: {}", attempt, e);
                if attempt < 3 {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        }
    }
    Err(last_err)
}

/// 把 raw RGBA bytes 编码成 PNG（用 image crate 的 RgbaImage）
fn encode_rgba_to_png(raw: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    use image::ImageEncoder;

    let mut out: Vec<u8> = Vec::with_capacity((width * height * 4) as usize);
    {
        let encoder = image::codecs::png::PngEncoder::new(&mut out);
        encoder
            .write_image(raw, width, height, image::ExtendedColorType::Rgba8)
            .map_err(|e| format!("PNG 编码失败: {}", e))?;
    }
    Ok(out)
}

fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(CHARS[((n >> 6) & 63) as usize] as char);
        out.push(CHARS[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(CHARS[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}
