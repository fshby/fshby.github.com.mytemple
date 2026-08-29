// server.rs — 嵌入式 axum HTTP 服务器
// Tauri 原生架构的桥接层：WebView2 加载本地前端，原生 handler 处理全部 /api。
//
// Phase 5（当前）：纯原生模式
//   - 所有 API 端点均由 Rust 原生 axum handler 处理，不依赖 Node.js sidecar。
//   - 未被路由匹配的请求返回前端 index.html (SPA) 或 404。
//
// 监听端口：优先 MYTEMPLE_PORT 环境变量；否则 7321。端口被占用/防火墙拒绝绑定则
//          自动从 7322..=7420 顺序扫描，返回实际监听端口给 Tauri 启动器。

use axum::Router;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::services::{ServeDir, ServeFile};

/// 监听端口回传：run 返回真实绑定的端口（其他电脑上 7321 被占用时回滚到 7322..7420）
pub struct ServerBound {
    pub port: u16,
}

// ── 服务器共享状态 ──

/// 服务器状态：组合原生 AppState + RAG 服务
#[derive(Clone)]
pub struct ServerState {
    /// 原生应用状态（文件/工作区/搜索等）
    pub app: Arc<crate::app::AppState>,
    /// RAG 向量检索服务
    pub rag: Arc<crate::rag::RagService>,
}

// ── 静态资源解析 ──

/// 解析前端静态资源根目录。返回 `(选定目录, 全部尝试过的候选列表)`，后者用于
/// 内置 404 友好错误页完整展示（绝不向用户只展示 1 条误导性的路径）。
///
/// 优先级（越高越先尝试，目录存在且含 index.html 才返回）：
///   1. `MYTEMPLE_PUBLIC_ROOT` 环境变量（强制指定）
///   2. `<exe_dir>/resources/public`              — Tauri 2 NSIS 对象映射 target=resources/public（安装位置）
///   3. `<exe_dir>/resources/resources/public`    — 打包时 resources 再套 resources 的极端兜底
///   4. `<exe_dir>/public`                        — 绿色免安装 / Tauri 默认字符串资源解包到 $INSTDIR/public
///   5. `<exe_dir>/_up_/public`                   — Tauri 构建中间态（target/release/_up_）
///   6. `<CARGO_MANIFEST_DIR>/../public`          — cargo build / cargo tauri dev
///   7. `<CARGO_MANIFEST_DIR>/public`             — src-tauri/public 直接放
///   8. `%APPDATA%/MyTemple Knowledge/public`     — 用户数据区手动放
///   9. `./public`                                — 进程 CWD
///  10. `./resources/public`                      — CWD/resources/public
///
/// 所有候选都失败时回退到 candidates[0]（env 优先，否则就是 exe_dir/resources/public），
/// 但日志和内置 404 HTML 都会列出 **全部 10 条候选**，避免误导。
fn resolve_public_root() -> (PathBuf, Vec<PathBuf>) {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1) env override
    if let Ok(root) = std::env::var("MYTEMPLE_PUBLIC_ROOT") {
        candidates.push(PathBuf::from(root));
    }
    // 2) exe_dir/resources/public
    if let Some(ref d) = exe_dir {
        candidates.push(d.join("resources").join("public"));
    }
    // 3) exe_dir/resources/resources/public（套娃兜底）
    if let Some(ref d) = exe_dir {
        candidates.push(d.join("resources").join("resources").join("public"));
    }
    // 4) exe_dir/public
    if let Some(ref d) = exe_dir {
        candidates.push(d.join("public"));
    }
    // 5) exe_dir/_up_/public
    if let Some(ref d) = exe_dir {
        candidates.push(d.join("_up_").join("public"));
    }
    // 6) CARGO_MANIFEST_DIR/../public
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(parent) = manifest.parent() {
            candidates.push(parent.join("public"));
        }
    }
    // 7) CARGO_MANIFEST_DIR/public
    {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("public"));
    }
    // 8) APPDATA/MyTemple Knowledge/public
    if let Ok(appdata) = std::env::var("APPDATA") {
        candidates.push(PathBuf::from(appdata).join("MyTemple Knowledge").join("public"));
    }
    // 9) ./public
    candidates.push(PathBuf::from("public"));
    // 10) ./resources/public
    candidates.push(PathBuf::from("resources").join("public"));

    for p in &candidates {
        if p.is_dir() && p.join("index.html").is_file() {
            log::info!("前端静态目录选定: {} (含 index.html)", p.display());
            return (p.clone(), candidates);
        }
        if p.is_dir() {
            log::warn!("候选 public 目录存在但缺少 index.html: {}", p.display());
        }
    }
    let fallback = candidates
        .clone()
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from("public"));
    log::error!(
        "[FATAL] 未找到可用的前端 public 目录（含 index.html）。回退到 {:?}\n全部候选:\n  {}",
        fallback,
        candidates
            .iter()
            .map(|p| format!("{}", p.display()))
            .collect::<Vec<_>>()
            .join("\n  ")
    );
    (fallback, candidates)
}

/// 选择并绑定可用端口：按 `start_port..=start_port+99` 递增扫描，
/// 成功返回 `(listener, port)`；全部都被占用返回错误。
async fn bind_first_available(start_port: u16) -> anyhow::Result<(tokio::net::TcpListener, u16)> {
    let end_port = start_port.saturating_add(99).min(u16::MAX);
    for port in start_port..=end_port {
        let addr = format!("127.0.0.1:{}", port);
        match tokio::net::TcpListener::bind(&addr).await {
            Ok(listener) => {
                if port != start_port {
                    log::warn!("默认端口 {} 被占用，改用端口 {} 启动 axum", start_port, port);
                }
                return Ok((listener, port));
            }
            Err(_) => continue,
        }
    }
    anyhow::bail!(
        "没有可用端口：范围 {}..={} 全被占用，请关闭其他占用端口的程序或设置 MYTEMPLE_PORT",
        start_port,
        end_port
    )
}

// ── 服务器启动 ──

/// 构建并运行 axum 服务器，返回实际绑定的端口（ServerBound）给 Tauri 启动器，
/// 以便 Tauri window navigate 到真实端口（而不是写死 7321 然后 404）。
pub async fn run(
    port: u16,
    app_state: Arc<crate::app::AppState>,
    rag_service: Arc<crate::rag::RagService>,
) -> anyhow::Result<ServerBound> {
    let (public_root, candidates) = resolve_public_root();

    let state = Arc::new(ServerState {
        app: app_state,
        rag: rag_service,
    });

    // 如果 public_root/index.html 不存在（打包漏资源或权限），提供「内置最小 404
    // 友好启动页」兜底：不用真实 ServeFile 加载 public 不存在的 index.html，
    // 而是用 axum 路由响应可读错误页（不黑/不 404 Edge 白页）
    let index_path = public_root.join("index.html");
    let has_index = index_path.is_file();

    let (listener, real_port) = bind_first_available(port).await?;

    let app = if has_index {
        // 正常路径：ServeDir public + not_found → index.html (SPA fallback)
        let serve = ServeDir::new(&public_root)
            .not_found_service(ServeFile::new(&index_path));
        Router::new()
            .merge(crate::handlers::build_native_router(state))
            .fallback_service(serve)
    } else {
        // 异常：前端资源缺失。返回最小错误页（枚举全部 10 条候选，杜绝仅展示 1 条误导）。
        use axum::{
            body::Body,
            http::{Response, StatusCode},
            response::IntoResponse,
            routing::get,
        };
        let candidates_display = candidates
            .iter()
            .enumerate()
            .map(|(i, p)| format!("{:>2}. {}", i + 1, p.display()))
            .collect::<Vec<_>>()
            .join("\n");
        let missing_html = format!(
            r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>前端资源缺失</title></head>
<body style="margin:0;padding:48px 24px;font-family:'PingFang SC','Microsoft YaHei',sans-serif;background:#1e293b;color:#f8fafc;">
<div style="max-width:860px;margin:0 auto;">
  <h2 style="color:#fbbf24;margin:0 0 12px 0;">启动失败：前端资源缺失（v1.8.104 完整候选）</h2>
  <p>安装后 10 条候选目录下都没找到 <code style="background:#0f172a;padding:2px 6px;border-radius:4px;">index.html</code>。</p>
  <p>通常是：①<b>杀毒软件/实时防护把安装目录下的 public 文件删了</b>；②<b>NSIS 打包时 bundle.resources 映射路径错了</b>；③ 极少数情况下 C 盘权限不足。下方会列出 <b>全部尝试过的路径</b>，用户自己就能对比真实目录结构。</p>
  <div style="margin-top:20px;padding:16px;background:#0f172a;border:1px solid #334155;border-radius:8px;">
    <div><b>已尝试的静态资源目录（共 {} 条，都没有 index.html）：</b></div>
    <pre style="white-space:pre-wrap;color:#cbd5e1;line-height:1.75;">{}
</pre>
  </div>
  <div style="margin-top:18px;">
    <b>解决方式（按推荐顺序）：</b>
    <ol>
      <li>先 <b>卸载当前版本</b> → 关闭杀毒软件/企业杀软/Defender 实时防护 → 下载 <b>v1.8.104 或更新版</b> 再安装（v1.8.104 开始用对象映射强制写到 resources/public，不再歧义）。</li>
      <li>临时救急：在其它电脑的相同安装目录 <code style="background:#0f172a;padding:2px 6px;border-radius:4px;">C:\Program Files\MyTemple Knowledge\</code> 下，手动把 <code>resources/public/</code>（含 index.html、app.js、styles.css）完整拷贝过去。</li>
      <li>临时救急：设置<b>用户环境变量</b> <code style="background:#0f172a;padding:2px 6px;border-radius:4px;">MYTEMPLE_PUBLIC_ROOT</code> = <code style="background:#0f172a;padding:2px 6px;border-radius:4px;">C:\Program Files\MyTemple Knowledge\resources\public</code>（或真实存在 index.html 的绝对路径），重启 MyTemple Knowledge。</li>
      <li>仍失败请把这张错误页 + 安装目录截图（Explorer 打开安装目录展开 resources/public）发给管理员/在群里反馈，我们会根据第 N 条缺失定位问题。</li>
    </ol>
  </div>
</div></body></html>"#,
            candidates.len(),
            candidates_display
        );
        Router::new()
            .merge(crate::handlers::build_native_router(state))
            .fallback(get(move || async move {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "text/html; charset=utf-8")
                    .body(Body::from(missing_html.clone()))
                    .unwrap()
                    .into_response()
            }))
    };

    log::info!(
        "axum 服务器监听 http://127.0.0.1:{} (前端: {})",
        real_port,
        public_root.display()
    );
    // spawn server 永远运行，不阻塞调用方返回 port
    tokio::spawn(async move {
        let res = axum::serve(listener, app).await;
        if let Err(e) = res {
            log::error!("[boot] axum 服务器运行中退出: {}", e);
        }
    });
    Ok(ServerBound { port: real_port })
}
