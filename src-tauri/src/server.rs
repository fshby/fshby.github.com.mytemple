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

/// 解析前端静态资源根目录。
///
/// 优先级（越高越先尝试，存在才返回）：
///   1. `MYTEMPLE_PUBLIC_ROOT` 环境变量（开发/调试强制指定）
///   2. `<可执行文件目录>/resources/public` — 安装后最常用。Tauri NSIS 安装
///      器把 `bundle.resources = ["../public"]` 解压到 `exe/resources/public/`
///   3. `<可执行文件目录>/public` — 绿色免安装（把 public 文件夹丢在 exe 旁）
///   4. `<CARGO_MANIFEST_DIR>/../public` — cargo build / cargo tauri dev
///      编译期目录下的项目 public
///   5. `./public`（进程 CWD 下）— 兜底
///
/// 若以上候选都不存在，返回最后一个兜底路径（后续 404 HTML 写友好错误
/// 画面，而不是 panic 让用户只能看到 WebView 空白）。
fn resolve_public_root() -> PathBuf {
    // 2/3 所需 exe_dir 先求一次
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1) env override
    if let Ok(root) = std::env::var("MYTEMPLE_PUBLIC_ROOT") {
        candidates.push(PathBuf::from(root));
    }
    // 2) exe_dir/resources/public (bundle.resources=["../public"] 解包位置)
    if let Some(ref d) = exe_dir {
        candidates.push(d.join("resources").join("public"));
    }
    // 3) exe_dir/public 绿色便携
    if let Some(ref d) = exe_dir {
        candidates.push(d.join("public"));
    }
    // 4) CARGO_MANIFEST_DIR/../public 开发
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(parent) = manifest.parent() {
            candidates.push(parent.join("public"));
        }
    }
    // 5) ./public
    candidates.push(PathBuf::from("public"));

    for p in &candidates {
        if p.is_dir() {
            // 进一步校验含 index.html（不是空 public 目录）
            if p.join("index.html").is_file() {
                log::info!("前端静态目录选定: {} (含 index.html)", p.display());
                return p.clone();
            } else {
                log::warn!("候选 public 目录存在但缺少 index.html: {}", p.display());
            }
        }
    }
    // 没找到 — 返回候选首位（若 env 设置了返回 env 否则 ./public），
    // 并在日志里把整个候选列表都吐出来便于排障
    let fallback = candidates.into_iter().next().unwrap_or_else(|| PathBuf::from("public"));
    log::error!(
        "[FATAL] 未找到可用的前端 public 目录（含 index.html）。回退到 {:?}",
        fallback
    );
    fallback
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
    let public_root = resolve_public_root();

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
        // 异常：前端资源缺失。返回一个最小错误页 + 静态资源 404。
        use axum::{
            body::Body,
            http::{Response, StatusCode},
            response::IntoResponse,
            routing::get,
        };
        let missing_html = format!(
            r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>前端资源缺失</title></head>
<body style="margin:0;padding:48px 24px;font-family:'PingFang SC','Microsoft YaHei',sans-serif;background:#1e293b;color:#f8fafc;">
<div style="max-width:760px;margin:0 auto;">
  <h2 style="color:#fbbf24;margin:0 0 12px 0;">启动失败：前端资源缺失</h2>
  <p>安装目录中找不到 <code style="background:#0f172a;padding:2px 6px;border-radius:4px;">public/index.html</code>。</p>
  <p>这通常是因为 <b>安装包没有把前端文件打入 resources/public</b>，或杀毒软件删除了安装目录下的前端文件。</p>
  <div style="margin-top:20px;padding:16px;background:#0f172a;border:1px solid #334155;border-radius:8px;">
    <div><b>当前静态资源目录尝试路径（都不存在 index.html）：</b></div>
    <pre style="white-space:pre-wrap;color:#cbd5e1;">{}</pre>
  </div>
  <div style="margin-top:18px;">
    <b>解决方式：</b>
    <ol>
      <li>先 <b>卸载当前版本</b> → 关闭杀毒软件/防火墙实时防护 → 重新安装最新版安装包。</li>
      <li>仍失败时：把官网最新版安装包发给管理员，在安装目录下手动检查是否存在 <code style="background:#0f172a;padding:2px 6px;border-radius:4px;">resources/public/index.html</code>。</li>
      <li>或设置环境变量 <code style="background:#0f172a;padding:2px 6px;border-radius:4px;">MYTEMPLE_PUBLIC_ROOT</code> 指向含 index.html 的前端目录后重启。</li>
    </ol>
  </div>
</div></body></html>"#,
            public_root.display()
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
