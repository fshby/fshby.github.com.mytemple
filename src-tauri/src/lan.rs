// lan.rs — 局域网共享（LAN Share）
//
// 设计原则：旁路独立监听，与回环主通道完全隔离。
//   本机 WebView2 → 127.0.0.1:7321（现有通道，host_guard 保护，一行不动）
//   局域网访客   → 0.0.0.0:17321..17420（本模块，token 鉴权 + 端点白名单）
//
// 鉴权模型（简单校验）：
//   1. 桌面端开启共享 → 生成 6 位 PIN，展示 http://<局域网IP>:<端口>；
//   2. 访客浏览器打开地址 → 访客页输入 PIN → POST /api/lan/verify；
//   3. PIN 正确 → 签发 12h token（存 localStorage，请求带 X-Lan-Token 头）；
//   4. PIN 连错 5 次 → 锁定 60 秒（全局计数，防暴力猜解）；
//   5. 只读/可编辑两档，lan_guard 在只读模式下直接 403 写入端点。
//
// 白名单之外的端点根本不挂路由（删除/移动/重命名/目录浏览/Agent/授权/截图等
// 敏感能力对访客不存在，而不是"存在但被拦"）。静态资源只放行访客页所需清单。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};

use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, RwLock};

/// 访客 token 有效期：12 小时
pub const LAN_TOKEN_TTL_MS: u64 = 12 * 3600 * 1000;
/// PIN 连续错误上限（达到即锁定）
pub const LAN_PIN_MAX_FAILS: u32 = 5;
/// 锁定时长：60 秒
pub const LAN_LOCK_MS: u64 = 60_000;
/// 访客监听端口扫描起点（17321..=17420，与主通道 7321..=7420 分离）
pub const LAN_PORT_START: u16 = 17321;

/// 访客可访问的静态资源白名单（其余文件一概 404，缩小暴露面）
pub const LAN_STATIC_ALLOW: &[&str] = &[
    "guest.html",
    "guest.css",
    "guest.js",
    "editor-core.js",
    "styles.css",
    "logo.png",
    "logo.webp",
    "favicon.ico",
];

pub struct LanShareState {
    data_root: PathBuf,
    /// 前端静态资源根目录（访客页 static 白名单从这里读）
    pub public_root: PathBuf,
    /// 配置是否已从磁盘加载（懒加载，AppState::new 是同步函数）
    loaded: AtomicBool,
    /// 共享是否开启
    enabled: AtomicBool,
    /// 只读 / 可编辑
    read_only: RwLock<bool>,
    /// 当前 PIN（重启或重新生成时更换）
    pin: RwLock<String>,
    /// token → 过期时间(ms)
    tokens: Mutex<HashMap<String, u64>>,
    /// (连续错误次数, 锁定截止 ms)；0 = 未锁定
    attempts: Mutex<(u32, u64)>,
    /// 访客服务器任务句柄（关闭 = abort）
    server: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 实际监听端口（0 = 未开启）
    port: AtomicU16,
}

impl LanShareState {
    pub fn new(data_root: PathBuf) -> Self {
        let (public_root, _) = crate::server::resolve_public_root();
        Self {
            data_root,
            public_root,
            loaded: AtomicBool::new(false),
            enabled: AtomicBool::new(false),
            read_only: RwLock::new(false),
            pin: RwLock::new(String::new()),
            tokens: Mutex::new(HashMap::new()),
            attempts: Mutex::new((0, 0)),
            server: Mutex::new(None),
            port: AtomicU16::new(0),
        }
    }

    fn config_path(&self) -> PathBuf {
        self.data_root.join("lan-share.json")
    }

    /// 懒加载持久化配置（enabled / readOnly）。
    /// token/PIN 不持久化：每次启动重新生成，杜绝旧 token 残留。
    async fn ensure_loaded(&self) {
        if self.loaded.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(data) = std::fs::read_to_string(self.config_path()) {
            let data = data.strip_prefix('\u{feff}').unwrap_or(&data);
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                let enabled = v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false);
                let read_only = v.get("readOnly").and_then(|x| x.as_bool()).unwrap_or(false);
                self.enabled.store(enabled, Ordering::SeqCst);
                *self.read_only.write().await = read_only;
            }
        }
    }

    async fn save_config(&self) {
        let cfg = json!({
            "enabled": self.enabled.load(Ordering::SeqCst),
            "readOnly": *self.read_only.read().await,
        });
        if let Some(parent) = self.config_path().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(s) = serde_json::to_string_pretty(&cfg) {
            let _ = std::fs::write(self.config_path(), s);
        }
    }

    pub async fn is_read_only(&self) -> bool {
        *self.read_only.read().await
    }

    pub async fn is_enabled(&self) -> bool {
        self.ensure_loaded().await;
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn current_port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    /// 由 uuid v4 字节派生 6 位数字 PIN（首位 1..=9，避免缩位歧义）
    fn pin_from_uuid() -> String {
        let b = uuid::Uuid::new_v4().as_bytes().to_vec();
        let first = (b[0] % 9) + 1;
        let mut s = first.to_string();
        for i in 1..6 {
            s.push_str(&(b[i] % 10).to_string());
        }
        s
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// 校验 PIN 并签发 token。错误返回 (HTTP 状态码, JSON 响应体)。
    pub async fn verify_pin(&self, pin: &str) -> Result<Value, (u16, Value)> {
        let now = Self::now_ms();
        {
            let (fails, lock_until) = *self.attempts.lock().await;
            if now < lock_until {
                let retry_after = (lock_until - now).div_ceil(1000);
                return Err((
                    429,
                    json!({"ok": false, "error": format!("尝试次数过多，请 {} 秒后再试", retry_after), "retryAfter": retry_after}),
                ));
            }
        }
        let current = self.pin.read().await.clone();
        if !current.is_empty() && pin == current {
            *self.attempts.lock().await = (0, 0);
            // 顺手清理过期 token 后签发新 token
            let mut tokens = self.tokens.lock().await;
            tokens.retain(|_, exp| *exp > now);
            let token = uuid::Uuid::new_v4().to_string();
            tokens.insert(token.clone(), now + LAN_TOKEN_TTL_MS);
            return Ok(json!({
                "ok": true,
                "token": token,
                "expiresIn": LAN_TOKEN_TTL_MS / 1000,
            }));
        }
        // PIN 错误：计数，达到上限锁定 60s（锁定时清零计数，重开 5 次窗口）
        let mut attempts = self.attempts.lock().await;
        let fails = attempts.0 + 1;
        if fails >= LAN_PIN_MAX_FAILS {
            *attempts = (0, now + LAN_LOCK_MS);
            Err((
                429,
                json!({"ok": false, "error": "尝试次数过多，已锁定 60 秒", "retryAfter": LAN_LOCK_MS / 1000}),
            ))
        } else {
            *attempts = (fails, 0);
            Err((
                401,
                json!({
                    "ok": false,
                    "error": format!("口令不正确（还可尝试 {} 次）", LAN_PIN_MAX_FAILS - fails),
                    "attemptsLeft": LAN_PIN_MAX_FAILS - fails,
                }),
            ))
        }
    }

    /// token 是否有效（lan_guard 调用）
    pub async fn check_token(&self, token: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        let now = Self::now_ms();
        let tokens = self.tokens.lock().await;
        tokens.get(token).map(|&exp| exp > now).unwrap_or(false)
    }

    /// 局域网 IPv4 探测：UDP connect 不发包，读本端地址即可拿到出口接口 IP。
    /// 多个探测目标覆盖多网卡场景，去重保序。
    pub fn lan_ips() -> Vec<String> {
        let mut ips = Vec::new();
        for target in ["8.8.8.8:80", "114.114.114.114:80", "223.5.5.5:80", "192.168.255.255:80"] {
            if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
                if sock.connect(target).is_ok() {
                    if let Ok(addr) = sock.local_addr() {
                        let ip = addr.ip().to_string();
                        if !ip.starts_with("127.") && !ips.contains(&ip) {
                            ips.push(ip);
                        }
                    }
                }
            }
        }
        ips
    }

    pub async fn status(&self) -> Value {
        self.ensure_loaded().await;
        let enabled = self.enabled.load(Ordering::SeqCst);
        let port = self.current_port();
        let (fails, lock_until) = *self.attempts.lock().await;
        let tokens = self.tokens.lock().await;
        let now = Self::now_ms();
        let active_tokens = tokens.values().filter(|&&e| e > now).count();
        json!({
            "enabled": enabled,
            "readOnly": *self.read_only.read().await,
            "port": port,
            "pin": if enabled { self.pin.read().await.clone() } else { String::new() },
            "ips": Self::lan_ips(),
            "activeGuests": active_tokens,
            "attemptsLeft": if lock_until > now { 0 } else { LAN_PIN_MAX_FAILS - fails },
            "lockedFor": if lock_until > now { (lock_until - now).div_ceil(1000) } else { 0 },
        })
    }

    /// 开启共享（生成/保留 PIN + 启动访客监听）。重复开启是幂等的（只更新模式）。
    pub async fn enable(self: Arc<Self>, sstate: Arc<crate::server::ServerState>, read_only: bool) -> Result<Value, String> {
        self.ensure_loaded().await;
        *self.read_only.write().await = read_only;
        {
            let mut pin = self.pin.write().await;
            if pin.is_empty() {
                *pin = Self::pin_from_uuid();
            }
        }
        if self.current_port() == 0 {
            self.clone().start_listener(sstate).await?;
        }
        self.enabled.store(true, Ordering::SeqCst);
        self.save_config().await;
        log::info!("[lan] 局域网共享已开启（{}）", if read_only { "只读" } else { "可编辑" });
        Ok(self.status().await)
    }

    /// 关闭共享：abort 访客监听 + 清空 token
    pub async fn disable(&self) -> Value {
        self.ensure_loaded().await;
        if let Some(handle) = self.server.lock().await.take() {
            handle.abort();
        }
        self.port.store(0, Ordering::SeqCst);
        self.enabled.store(false, Ordering::SeqCst);
        self.tokens.lock().await.clear();
        self.save_config().await;
        log::info!("[lan] 局域网共享已关闭");
        self.status().await
    }

    /// 切换只读/可编辑（运行中即时生效：lan_guard 每次请求都读当前模式）
    pub async fn set_mode(&self, read_only: bool) -> Value {
        self.ensure_loaded().await;
        *self.read_only.write().await = read_only;
        self.save_config().await;
        self.status().await
    }

    pub async fn regenerate_pin(&self) -> Value {
        *self.pin.write().await = Self::pin_from_uuid();
        // 换 PIN 同时清空已配对访客（旧 token 全部失效），符合「重新配对」语义
        self.tokens.lock().await.clear();
        self.status().await
    }

    /// 开机自启：持久化配置里 enabled=true 时重新开启监听并生成新 PIN
    pub async fn autostart(self: Arc<Self>, sstate: Arc<crate::server::ServerState>) {
        self.ensure_loaded().await;
        if !self.enabled.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut pin = self.pin.write().await;
            if pin.is_empty() {
                *pin = Self::pin_from_uuid();
            }
        }
        match self.clone().start_listener(sstate).await {
            Ok(_) => log::info!("[lan] 自启动成功，访客地址见设置面板"),
            Err(e) => {
                log::warn!("[lan] 自启动失败: {}（已回退为关闭状态）", e);
                self.enabled.store(false, Ordering::SeqCst);
                let _ = std::fs::write(
                    self.config_path(),
                    serde_json::to_string(&json!({
                        "enabled": false,
                        "readOnly": *self.read_only.read().await,
                    }))
                    .unwrap_or_default(),
                );
            }
        }
    }

    /// 绑定 0.0.0.0 并启动访客 axum 服务（端口扫描 LAN_PORT_START..=+99）
    async fn start_listener(self: Arc<Self>, sstate: Arc<crate::server::ServerState>) -> Result<(), String> {
        if self.current_port() != 0 {
            return Ok(()); // 已在运行
        }
        let mut bound: Option<(TcpListener, u16)> = None;
        for port in LAN_PORT_START..=LAN_PORT_START.saturating_add(99) {
            match TcpListener::bind(format!("0.0.0.0:{}", port)).await {
                Ok(l) => {
                    bound = Some((l, port));
                    break;
                }
                Err(_) => continue,
            }
        }
        let (listener, port) = bound
            .ok_or_else(|| format!("没有可用端口：{}..={} 全被占用", LAN_PORT_START, LAN_PORT_START + 99))?;
        self.port.store(port, Ordering::SeqCst);

        let app = crate::handlers::build_lan_router(sstate, self.clone());
        let handle = tokio::spawn(async move {
            let res = axum::serve(listener, app).await;
            if let Err(e) = res {
                log::error!("[lan] 访客服务器退出: {}", e);
            }
        });
        *self.server.lock().await = Some(handle);
        log::info!("[lan] 访客监听已启动 http://0.0.0.0:{}", port);
        Ok(())
    }
}

/// LAN_STATIC_ALLOW 的成员级测试（独立于 HTTP 层，锁住白名单内容）。
#[cfg(test)]
mod tests {
    use super::LAN_STATIC_ALLOW;

    #[test]
    fn lan_static_allowlist_has_no_sensitive_files() {
        // 访客可下载的静态文件绝不能包含主应用入口 / 配置 / 云端模块
        for f in LAN_STATIC_ALLOW {
            assert!(!f.starts_with("app."), "app.js 不允许暴露给访客");
            assert!(!f.starts_with("cloud"), "云端模块不允许暴露给访客");
            assert!(!f.starts_with("index"), "主应用入口不允许暴露给访客");
        }
        // 访客页三件套必须在白名单里，否则访客页打不开
        assert!(LAN_STATIC_ALLOW.contains(&"guest.html"));
        assert!(LAN_STATIC_ALLOW.contains(&"guest.js"));
        assert!(LAN_STATIC_ALLOW.contains(&"editor-core.js"));
    }
}
