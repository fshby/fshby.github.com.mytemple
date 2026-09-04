// lib.rs — MyTemple Knowledge Rust 后端
// 模块入口 + Tauri command 注册。
// Phase 5 纯原生架构：Rust 负责全部 API（文件I/O/加密/搜索/图谱/RAG），
// WebView2 运行前端 SPA，不再依赖 Node.js sidecar。

pub mod agent_policy;
pub mod app;
pub mod converter;
pub mod doc_views;
pub mod frontmatter;
pub mod graph;
pub mod handlers;
pub mod ipc;
pub mod license;
pub mod rag;
pub mod server;
pub mod utils;

use serde::{Deserialize, Serialize};
use std::fs as stdfs;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{Emitter, Listener, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ── 全局 AppHandle 单例 ──
// HTTP handler（axum）需要弹原生对话框（save-as / 打开文件 / 定位文件夹），
// 这些能力都在 tauri::AppHandle 上，而 axum 的 ServerState 不含 AppHandle。
// 用 OnceLock 在 Tauri setup 时注入一次，此后全进程可安全获取。
pub static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

// ── Tauri 应用入口 ────────────────────────────────────────
/// 启动 Tauri 应用（Phase 5 纯原生模式）：
///   0. 确保 WebView2Loader.dll 与 exe 同级
///   1. 创建一个未初始化的 AppState + RAG（内存为空，但可以读）
///   2. 立即启动 axum 服务器（先提供静态资源 splash.html + boot.webp）
///   3. 轮询 axum 就绪后，窗口导航到 /splash.html（真实启动页：boot.webp 背景 + 进度条）
///   4. 后台 init AppState + RAG 加载，每个阶段通过 window.eval 更新进度条
///   5. 全部就绪后 navigate 到 /，前端 index.html 内的 appSplash 继续显示自己的进度条
pub fn run() {
    env_logger::init();

    // ── 0. 修复 WebView2Loader.dll 位置 ──────────────────
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let dll_in_exe_dir = exe_dir.join("WebView2Loader.dll");
            if !dll_in_exe_dir.exists() {
                let candidates: Vec<PathBuf> = vec![
                    exe_dir.join("resources").join("WebView2Loader.dll"),
                    exe_dir.join("WebView2Loader.dll"),
                ];
                for src in candidates {
                    if src.exists() {
                        match stdfs::copy(&src, &dll_in_exe_dir) {
                            Ok(_) => {
                                log::info!("已把 WebView2Loader.dll 复制到 {:?}", exe_dir);
                                break;
                            }
                            Err(e) => log::warn!("复制 WebView2Loader.dll 失败 {:?}->{:?}: {}", src, dll_in_exe_dir, e),
                        }
                    }
                }
            }
        }
    }

    let requested_port: u16 = std::env::var("MYTEMPLE_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(7321);
    // axum 端口写死 7321 容易在"其他电脑"上被占用/WMI/防火墙/VPN/浏览器 devtools 占位
    // server::run() 内部会 7321..=7420 顺序回滚，返回真实绑定 ServerBound.port
    let (server_port_tx, mut server_port_rx) = tokio::sync::oneshot::channel::<u16>();
    // 初始化默认"期望就是 requested_port"，并在 server::run OK 后立即回填真实端口
    let data_root = std::env::var("MYTEMPLE_DATA_ROOT")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var("APPDATA")
                .map(PathBuf::from)
                .map(|p| p.join("MyTemple Knowledge"))
                .unwrap_or_else(|_| PathBuf::from("."))
        });

    // 1) 预创建"空" AppState + RAG：字段均为 Arc<RwLock<Vec/None>>，API 可读（为空值），不会 crash
    //    init() 稍后在 splash 进度阶段填充这些字段
    let empty_app_state = std::sync::Arc::new(app::AppState::new(data_root.clone()));
    let empty_rag = std::sync::Arc::new(rag::RagService::new(&data_root));

    let data_root_for_init = data_root.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            // ── 导入/导出 原生对话框（旧 5 条） ──
            tauri_cmd::cmd_export_save_as,
            tauri_cmd::cmd_open_exported_file,
            tauri_cmd::cmd_reveal_exported_file_in_folder,
            tauri_cmd::cmd_import_pick_files,
            tauri_cmd::cmd_import_read_file,
            // ── 工作区（7） ──
            tauri_cmd::api_get_workspaces,
            tauri_cmd::api_add_workspace,
            tauri_cmd::api_remove_workspace,
            tauri_cmd::api_rename_workspace,
            tauri_cmd::api_set_default_workspace,
            tauri_cmd::api_show_workspace,
            tauri_cmd::api_set_md_only,
            // ── 树 + 缓存刷新 ──
            tauri_cmd::api_get_tree,
            tauri_cmd::api_refresh_cache,
            // ── 文件 CRUD（3） + 文档 API（6） ──
            tauri_cmd::api_list_files,
            tauri_cmd::api_read_file,
            tauri_cmd::api_save_file,
            tauri_cmd::api_delete_file,
            tauri_cmd::api_get_doc,
            tauri_cmd::api_check_doc,
            tauri_cmd::api_save_doc,
            tauri_cmd::api_delete_docs,
            tauri_cmd::api_create_folder,
            tauri_cmd::api_create_document,
            // ── 搜索 + 图谱 ──
            tauri_cmd::api_search,
            tauri_cmd::api_get_graph,
            // ── Move/Copy/Rename（3） ──
            tauri_cmd::api_move_entry,
            tauri_cmd::api_copy_entry,
            tauri_cmd::api_rename_entry,
            // ── Frontmatter（3） ──
            tauri_cmd::api_get_frontmatter,
            tauri_cmd::api_preview_frontmatter,
            tauri_cmd::api_apply_frontmatter,
            // ── 系统操作（3） ──
            tauri_cmd::api_open_folder,
            tauri_cmd::api_open_url,
            tauri_cmd::api_browse_folder,
            // ── 版本 & 系统路径 & 健康检查 ──
            tauri_cmd::api_get_version,
            tauri_cmd::api_get_system_paths,
            tauri_cmd::api_health,
            tauri_cmd::api_knowledge_health,
            // ── 授权（4） ──
            tauri_cmd::api_license_status,
            tauri_cmd::api_license_check,
            tauri_cmd::api_license_activate,
            tauri_cmd::api_license_deactivate,
        ])
        .setup(move |app| -> Result<(), Box<dyn std::error::Error>> {
            // 注入全局 AppHandle 单例：HTTP handler（axum）需要弹原生对话框
            // （save-as / 打开文件 / 定位文件夹），必须通过此句柄调用 dialog plugin。
            let _ = APP_HANDLE.set(app.handle().clone());

            // 注册 IPC 共享状态：与 axum 共用同一 AppState+RAG，避免双缓存
            // (注意：共享 Arc 已通过 builder.manage 在 setup 前注册，此处仅保持可观测性)
            use tauri::Manager as _;
            let srv = std::sync::Arc::new(server::ServerState {
                app: empty_app_state.clone(),
                rag: empty_rag.clone(),
            });
            app.manage(srv.clone());

            // 0) 读取命令行文件路径参数（Windows 右键"打开方式"/"用 MyTemple 打开"传入）
            //    约定：跳过 argv[0]（exe 自身），收集后续参数中以 .md/.markdown/.txt 结尾的
            let open_paths: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| {
                    let lower = a.to_lowercase();
                    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt") || lower.ends_with(".html")
                })
                .collect();
            log::info!("[boot] 命令行文件参数: {:?}", open_paths);
            // 存到 AppHandle 可管理的状态，稍后前端 init 后 emit
            let app_handle_clone = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // 等待前端初始化（最多 5s），让 splash 先完成、API 就绪
                let mut wait_ms = 100u64;
                while wait_ms < 5000 {
                    tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
                    wait_ms = (wait_ms as f64 * 1.4) as u64;
                    if let Some(window) = app_handle_clone.get_webview_window("main") {
                        if window.url().is_ok() { break; }
                    }
                }
                if !open_paths.is_empty() {
                    match app_handle_clone.emit("open-files", &open_paths) {
                        Ok(_) => log::info!("[boot] 已向前端 emit open-files: {:?}", open_paths),
                        Err(e) => log::warn!("[boot] emit open-files 失败: {}", e),
                    }
                }
            });

            // 1) 启动 axum（立即：即使 API state 为空也 OK，splash 阶段只需静态文件）
            //    注意：AppState 内部字段用 Arc<RwLock>，init 过程中写入会被所有 API handler 立刻看到
            //    server::run 不阻塞返回 -> ServerBound { port: real_port }，我们通过 oneshot 回传
            let state_for_server = empty_app_state.clone();
            let rag_for_server = empty_rag.clone();
            tauri::async_runtime::spawn(async move {
                match server::run(requested_port, state_for_server, rag_for_server).await {
                    Ok(bound) => {
                        let _ = server_port_tx.send(bound.port);
                        // server::run 已经内部 tokio::spawn 了 axum.serve 循环，
                        // 这里 await 一个"永不结束的 sleep"让本 task 不退出
                        loop {
                            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                        }
                    }
                    Err(e) => {
                        log::error!("[boot] axum 服务器启动失败 (端口范围占用/权限?): {}", e);
                    }
                }
            });

            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                // 通过 External 直接指向 splash.html URL，axum 起来后就可以立刻加载 boot.webp 背景 + 进度条
                // 先设置 about:blank 作为 fallback（避免 Tauri 的 App URL 用资源协议 404 导致绿屏）
                tauri::WebviewUrl::External(url::Url::parse("about:blank").unwrap()),
            )
                .title("MyTemple Knowledge")
                .inner_size(1280.0, 820.0)
                .min_inner_size(960.0, 640.0)
                .maximized(true)
                .resizable(true)
                .center()
                .visible(false)
                .build()?;

            // 启动后台任务（async，可 .await）：先等真实端口，再轮询 axum → 注入 splash →
            // init AppState (进度更新) → 加载 RAG (进度更新) → navigate 到 /
            let window_clone = window.clone();
            let app_state_to_init = empty_app_state.clone();
            let rag_to_load = empty_rag.clone();
            let data_root_inner = data_root_for_init.clone();

            tauri::async_runtime::spawn(async move {
                // 1) 等待真实端口回填（setup() 是同步的，所以只能放到本 async 块里）
                let port_res = tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    &mut server_port_rx,
                )
                .await;
                let real_port: u16 = match port_res {
                    Ok(Ok(p)) => p,
                    Ok(Err(_)) => requested_port,
                    Err(_) => {
                        log::error!("[boot] 等待 axum 端口回传超时，回退到 requested_port={}", requested_port);
                        requested_port
                    }
                };
                let axum_home = format!("http://127.0.0.1:{}/?skipSplash=1", real_port);
                let axum_splash = format!("http://127.0.0.1:{}/splash.html", real_port);
                log::info!("[boot] axum 真实端口 {} (请求 {})，splash={}", real_port, requested_port, axum_splash);
                let splash_url = axum_splash.clone();
                let home_url = axum_home.clone();

                // 2) axum 已就绪：server::run 在 bind_first_available 成功后通过
                //    oneshot 回传 port，此时 TcpListener 已绑定，无需再轮询 TCP connect。
                //    3) 注册 splash_ready 事件监听，再 navigate 到 splash.html
                let (splash_ready_tx, splash_ready_rx) = tokio::sync::oneshot::channel::<()>();
                let splash_ready_tx = std::sync::Mutex::new(Some(splash_ready_tx));
                let _splash_event_id = window_clone.listen("splash_ready", move |_event| {
                    if let Ok(mut guard) = splash_ready_tx.lock() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(());
                        }
                    }
                });

                match url::Url::parse(&splash_url) {
                    Ok(parsed) => {
                        if let Err(e) = window_clone.navigate(parsed) {
                            log::warn!("[boot] splash navigate 失败 {:?}，改用 eval 兜底", e);
                            let _ = window_clone.eval(&format!("document.location.href = {:?};", splash_url));
                        }
                    }
                    Err(e) => log::error!("[boot] splash URL 解析失败: {}", e),
                }

                // 等待 splash.html 通过 Tauri 事件通知 DOM 就绪（3s 超时兜底）
                match tokio::time::timeout(
                    std::time::Duration::from_secs(3),
                    splash_ready_rx,
                ).await {
                    Ok(Ok(())) => log::info!("[boot] splash DOM ready"),
                    _ => log::warn!("[boot] splash_ready 超时，直接显示窗口"),
                }
                let _ = window_clone.show();

                // Helper: 通过 JS 更新 splash 进度条 & 文本
                let update_progress = |pct: u32, text: &str| -> String {
                    format!(
                        "void(function(){{var f=document.getElementById('splashProgressFill');var p=document.getElementById('splashProgressPct');var t=document.getElementById('splashProgressText');if(f)f.style.width='{}%';if(p)p.textContent='{}%';if(t)t.textContent={:?};}})();",
                        pct, pct, text
                    )
                };

                // 4a) 初始化 AppState（工作区扫描 + 文件索引）
                // 策略：AppState 的业务字段都是 Arc<RwLock<_>>，因此可以用以下两步：
                //   a) 在独立的 tmp_state 上执行 init()（需要 &mut self）
                //   b) 逐字段通过 write().await 把值拷贝到共享的 app_state_to_init
                //   init 完成前 API handler 读到的是空值，对 splash 阶段无影响。
                log::info!("[boot] data_root = {}", data_root_inner.display());
                let _ = window_clone.eval(&update_progress(10, "正在启动服务…"));
                let mut tmp_state = app::AppState::new(data_root_inner.clone());

                let _ = window_clone.eval(&update_progress(20, "正在加载工作区…"));
                let init_result = {
                    // 模拟分阶段：init 期间每 ~1 秒 bump 一次进度（20% → 35%）
                    let wc = window_clone.clone();
                    let up = update_progress.clone();
                    let progress_task = tokio::spawn(async move {
                        let mut pct = 22;
                        loop {
                            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
                            let _ = wc.eval(&up(pct, "正在加载工作区…"));
                            pct = (pct + 2).min(38);
                            if pct >= 38 { break; }
                        }
                    });
                    let res = tmp_state.init().await;
                    progress_task.abort();
                    let _ = progress_task.await;
                    res
                };

                // 拷贝 init 后字段
                {
                    let src_ws = tmp_state.workspaces.read().await.clone();
                    let mut dst = app_state_to_init.workspaces.write().await;
                    *dst = src_ws;
                }
                {
                    let src_def = tmp_state.default_workspace_id.read().await.clone();
                    let mut dst = app_state_to_init.default_workspace_id.write().await;
                    *dst = src_def;
                }
                {
                    let src_files = tmp_state.files.read().await.clone();
                    let mut dst = app_state_to_init.files.write().await;
                    *dst = src_files;
                }
                {
                    let src_tree = tmp_state.tree.read().await.clone();
                    let mut dst = app_state_to_init.tree.write().await;
                    *dst = src_tree;
                }
                {
                    let src_idx = tmp_state.search_index.read().await.clone();
                    let mut dst = app_state_to_init.search_index.write().await;
                    *dst = src_idx;
                }
                // data_root 是普通字段（非 Arc<RwLock>），在 AppState::new 时已设置一致，不用拷贝

                if let Err(e) = init_result {
                    log::error!("[boot] AppState 初始化失败: {}", e);
                } else {
                    log::info!("[boot] AppState 初始化完成");
                }
                let _ = window_clone.eval(&update_progress(50, "正在加载知识库索引…"));

                // 4b) 加载 RAG 向量索引（50% → 75%）
                {
                    let wc = window_clone.clone();
                    let up = update_progress.clone();
                    let progress_task = tokio::spawn(async move {
                        let mut pct = 55;
                        loop {
                            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                            let _ = wc.eval(&up(pct, "正在加载知识库索引…"));
                            pct = (pct + 3).min(75);
                            if pct >= 75 { break; }
                        }
                    });
                    // rag.load() 把索引写入 RwLock，共享引用即可（RagService 是 interior mutable）
                    let res = rag_to_load.load();
                    progress_task.abort();
                    let _ = progress_task.await;
                    match res {
                        Ok(()) => log::info!("[boot] RAG 服务加载完成"),
                        Err(e) => log::warn!("[boot] RAG 服务加载失败 (将以无AI模式运行): {}", e),
                    }
                }
                let _ = window_clone.eval(&update_progress(80, "正在初始化界面…"));

                // 4c) 进度条到 100% 后立即 navigate（不再 sleep 等动画）
                let _ = window_clone.eval(&update_progress(95, "即将完成…"));
                let _ = window_clone.eval(&update_progress(100, "加载完成"));

                // 5) 全部就绪 → navigate 到 /
                //    注意：index.html 内也有自己的 appSplash（boot.webp + 进度条），它会自动继续
                //    显示直到前端自己的 bootstrap() 完成 → hideSplash()
                log::info!("[boot] 导航到首页 {}", home_url);
                match url::Url::parse(&home_url) {
                    Ok(parsed) => {
                        if let Err(e) = window_clone.navigate(parsed) {
                            log::warn!("[boot] home navigate 失败 {:?}，改用 eval 兜底", e);
                            let _ = window_clone.eval(&format!("document.location.href = {:?};", home_url));
                        }
                    }
                    Err(e) => log::error!("[boot] home URL 解析失败: {}", e),
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

// ── Tauri Commands ────────────────────────────────────────
// 这些函数在 Tauri 模式下通过 IPC 从前端调用。
// 非 Tauri 模式下可通过 HTTP API 调用。

/// 检查授权状态（HTTP API 内部复用；Tauri IPC 不暴露，避免 &Path + 非 Result 参数限制）
pub async fn cmd_license_status(data_root: &std::path::Path) -> license::LicenseStatus {
    license::get_license_status(data_root)
}

/// 验证授权码（同上，仅 HTTP 复用）
pub async fn cmd_verify_license(
    license_key: &str,
    data_root: &std::path::Path,
) -> license::LicenseResult {
    license::verify_license(license_key, data_root)
}

/// 获取机器码（同上）
pub async fn cmd_machine_code() -> String {
    license::get_machine_code()
}

/// 读取文件内容（HTTP 复用）
pub async fn cmd_read_file(file_path: &str) -> Result<String, String> {
    tokio::fs::read_to_string(file_path)
        .await
        .map_err(|e| format!("读取文件失败: {}", e))
}

/// 写入文件内容（原子写入）
pub async fn cmd_save_file(file_path: &str, content: &str) -> Result<String, String> {
    let path = std::path::Path::new(file_path);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("创建目录失败: {}", e))?;
    }
    // 原子写入：先写临时文件，再 rename
    let tmp = format!("{}.{}.tmp", file_path, std::process::id());
    tokio::fs::write(&tmp, content)
        .await
        .map_err(|e| format!("写入临时文件失败: {}", e))?;
    tokio::fs::rename(&tmp, file_path)
        .await
        .or_else(|_| {
            // Windows rename 失败回退
            std::fs::write(file_path, content).map_err(|e| format!("写入文件失败: {}", e))
        })?;
    // 计算 SHA256
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    Ok(hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect::<String>())
}

/// 创建文档（含 frontmatter 模板）
pub async fn cmd_create_document(
    workspace_root: &str,
    name: &str,
) -> Result<String, String> {
    let template = frontmatter::create_document_template(name, None);
    let file_name = format!(
        "{}.md",
        name.trim().replace([' ', '/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_")
    );
    let file_path = std::path::Path::new(workspace_root).join(&file_name);
    cmd_save_file(file_path.to_str().unwrap_or(""), &template).await?;
    Ok(file_path.to_string_lossy().to_string())
}

/// 删除文件
pub async fn cmd_delete_file(file_path: &str) -> Result<(), String> {
    tokio::fs::remove_file(file_path)
        .await
        .map_err(|e| format!("删除文件失败: {}", e))
}

/// 重命名/移动文件
pub async fn cmd_move_file(from: &str, to: &str) -> Result<(), String> {
    if let Some(dir) = std::path::Path::new(to).parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("创建目录失败: {}", e))?;
    }
    tokio::fs::rename(from, to)
        .await
        .map_err(|e| format!("移动文件失败: {}", e))
}

/// 构建目录树
pub async fn cmd_build_tree(root: &str) -> Result<Vec<TreeEntry>, String> {
    let root_path = std::path::Path::new(root);
    let mut entries = Vec::new();
    walk_dir(root_path, root_path, &mut entries, 0)?;
    entries.sort_by(|a, b| {
        // 目录优先，然后按名称
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn walk_dir(
    root: &std::path::Path,
    current: &std::path::Path,
    entries: &mut Vec<TreeEntry>,
    depth: u32,
) -> Result<(), String> {
    if depth > 10 {
        return Ok(()); // 防止过深递归
    }
    let dir = match std::fs::read_dir(current) {
        Ok(d) => d,
        Err(_) => return Ok(()),
    };
    for entry in dir.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // 跳过隐藏文件和 node_modules
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let is_dir = path.is_dir();
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        entries.push(TreeEntry {
            name,
            path: relative,
            is_dir,
            depth,
        });
        if is_dir {
            walk_dir(root, &path, entries, depth + 1)?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub depth: u32,
}

/// 全文搜索
pub async fn cmd_search(
    workspace_root: &str,
    query: &str,
) -> Result<Vec<SearchResult>, String> {
    let root = std::path::Path::new(workspace_root);
    let mut results = Vec::new();
    let query_lower = query.to_lowercase();
    let max_results = 100;

    for entry in walkdir::WalkDir::new(root)
        .max_depth(10)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_dir() {
            continue;
        }
        let path = entry.path();
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase());
        if ext.as_deref() != Some("md") {
            continue;
        }
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let content_lower = content.to_lowercase();
        if !content_lower.contains(&query_lower) {
            continue;
        }
        let relative = path.strip_prefix(root).unwrap_or(path).to_string_lossy().to_string();
        let excerpt = utils::create_index_excerpt(&content, 320);
        let headings = utils::extract_index_headings(&content);
        let title = headings
            .first()
            .map(|h| h.title.clone())
            .unwrap_or_else(|| {
                path.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            });
        results.push(SearchResult {
            path: relative,
            title,
            excerpt,
            match_count: content_lower.matches(&query_lower).count() as u32,
        });
        if results.len() >= max_results {
            break;
        }
    }
    Ok(results)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub excerpt: String,
    pub match_count: u32,
}

/// 打开 URL（系统默认浏览器）
pub async fn cmd_open_url(url: &str) -> Result<(), String> {
    // 仅允许 http/https/mailto/tel 协议
    if !url.starts_with("http://")
        && !url.starts_with("https://")
        && !url.starts_with("mailto:")
        && !url.starts_with("tel:")
    {
        return Err("仅支持 http/https/mailto/tel 协议".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", url])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("打开 URL 失败: {}", e))?;
    }
    Ok(())
}

/// 浏览文件夹
pub async fn cmd_browse_folder() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        // 使用 PowerShell FolderBrowserDialog
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "选择工作区文件夹"
if ($dialog.ShowDialog() -eq 'OK') { Write-Output $dialog.SelectedPath }
"#;
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| format!("启动文件夹选择器失败: {}", e))?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(Some(path));
            }
        }
        Ok(None)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

// ── Tauri IPC 子模块：导出 / 导入 6 条专用命令 ──────────────────
// 放到独立 mod 里是为了避免 crate 根宏名空间冲突：
//   `#[tauri::command]` 会生成 `macro_rules! __cmd__XXX` + `pub use {__cmd__XXX, ...};`。
//   若在 crate 根模块中同时出现，rustc 会因"同宏两次进入同一 macro namespace"报 E0255。
//   子模块的宏作用域与根级隔离，`use` 只把宏暴露给 mod 外部路径，不污染根 macro namespace。
//
// 旧 4 条 cmd_license_status / cmd_verify_license / cmd_machine_code / cmd_read_file
// 原本已被 HTTP handlers 直接调用，不通过 Tauri IPC 暴露，保留根级作为普通 async fn。
pub mod tauri_cmd {

// ── Legacy 导入/导出对话框 原生命令（5） ──
#[tauri::command]
pub async fn cmd_export_save_as(
    default_name: String, extensions: Vec<String>, data_base64: String,
    app_handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let extensions_list: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    app_handle.dialog().file()
        .add_filter("Documents", &extensions_list)
        .set_file_name(&default_name)
        .save_file(move |p| { let _ = tx.send(p.map(|x| x.to_string())); });
    let picked = rx.await.map_err(|_| "Dialog canceled (channel closed)".to_string())?;
    let Some(path) = picked else { return Ok(None); };
    let bytes = base64_decode(&data_base64).map_err(|e| format!("base64 decode failed: {}", e))?;
    std::fs::write(&path, bytes).map_err(|e| format!("write failed: {}", e))?;
    Ok(Some(path))
}

#[tauri::command]
pub async fn cmd_open_exported_file(path: String) -> Result<(), String> {
    open_path_in_system(&path)
}

#[tauri::command]
pub async fn cmd_reveal_exported_file_in_folder(path: String) -> Result<(), String> {
    reveal_in_folder(&path)
}

#[tauri::command]
pub async fn cmd_import_pick_files(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Vec<String>>();
    app_handle.dialog().file()
        .add_filter("All supported", &["md","txt","docx","doc","rtf","odt","pdf","pptx","xlsx","epub","html","json","csv"])
        .pick_files(move |p| {
            let list = p.unwrap_or_default().into_iter().map(|pp| pp.to_string()).collect();
            let _ = tx.send(list);
        });
    rx.await.map_err(|_| "Dialog closed".to_string())
}

#[tauri::command]
pub async fn cmd_import_read_file(path: String) -> Result<serde_json::Value, String> {
    use std::io::Read;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let size = meta.len() as usize;
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(size);
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let b64 = base64_encode(&buf);
    let name = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let ext = std::path::Path::new(&path).extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    Ok(serde_json::json!({ "ok": true, "name": name, "ext": ext, "size": size, "base64": b64 }))
}

fn open_path_in_system(p: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")] {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer").arg(p).creation_flags(0x08000000).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")] {
        std::process::Command::new("open").arg(p).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn reveal_in_folder(p: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")] {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer").args(["/select,", p]).creation_flags(0x08000000).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")] {
        std::process::Command::new("open").args(["-R", p]).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i+1] as u32) << 8) | (bytes[i+2] as u32);
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
        out.push('='); out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i+1] as u32) << 8);
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(CHARS[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim_end_matches('=');
    let mut buf: Vec<u8> = Vec::with_capacity(s.len() * 3 / 4);
    let mut n: u32 = 0;
    let mut bits: u8 = 0;
    for ch in s.bytes() {
        let v = match ch {
            b'A'..=b'Z' => (ch - b'A') as u32,
            b'a'..=b'z' => (ch - b'a' + 26) as u32,
            b'0'..=b'9' => (ch - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(format!("invalid base64 char: {}", ch as char)),
        };
        n = (n << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            buf.push(((n >> bits) & 0xff) as u8);
        }
    }
    Ok(buf)
}


// IPC Command wrappers — 薄包装：从 tauri::State 取出 Arc<ServerState>，
// 调用 crate::ipc::* 纯函数。所有带 Srv 参数的函数统一返回 Result 以满足
// Tauri 2 AsyncCommandMustReturnResult trait 约束。
type Srv<'r> = tauri::State<'r, std::sync::Arc<crate::server::ServerState>>;

// 版本 / 系统路径 / 健康检查
#[tauri::command]
pub async fn api_health() -> Result<serde_json::Value, String> {
    Ok(crate::ipc::health().await)
}
#[tauri::command]
pub async fn api_knowledge_health(s: Srv<'_>) -> Result<serde_json::Value, String> {
    Ok(crate::ipc::knowledge_health(&s).await)
}
#[tauri::command]
pub async fn api_get_version(refresh: Option<String>) -> Result<serde_json::Value, String> {
    Ok(crate::ipc::get_version(refresh.as_deref().unwrap_or("")).await)
}
#[tauri::command]
pub async fn api_get_system_paths() -> Result<serde_json::Value, String> {
    Ok(crate::ipc::get_system_paths().await)
}

// 工作区（7）
#[tauri::command]
pub async fn api_get_workspaces(s: Srv<'_>) -> Result<serde_json::Value, String> {
    Ok(crate::ipc::get_workspaces(&s).await)
}
#[tauri::command]
pub async fn api_add_workspace(s: Srv<'_>, path: String, name: Option<String>) -> Result<serde_json::Value, String> {
    crate::ipc::add_workspace(&s, path, name).await
}
#[tauri::command]
pub async fn api_remove_workspace(s: Srv<'_>, id: String) -> Result<serde_json::Value, String> {
    crate::ipc::remove_workspace(&s, id).await
}
#[tauri::command]
pub async fn api_rename_workspace(s: Srv<'_>, id: String, name: String) -> Result<serde_json::Value, String> {
    crate::ipc::rename_workspace(&s, id, name).await
}
#[tauri::command]
pub async fn api_set_default_workspace(s: Srv<'_>, id: String) -> Result<serde_json::Value, String> {
    crate::ipc::set_default_workspace(&s, id).await
}
#[tauri::command]
pub async fn api_show_workspace(s: Srv<'_>, id: String, visible: Option<bool>) -> Result<serde_json::Value, String> {
    crate::ipc::show_workspace(&s, id, visible).await
}
#[tauri::command]
pub async fn api_set_md_only(s: Srv<'_>, id: String, md_only: Option<bool>) -> Result<serde_json::Value, String> {
    crate::ipc::set_md_only(&s, id, md_only).await
}

// 树 / 缓存刷新
#[tauri::command]
pub async fn api_get_tree(s: Srv<'_>, refresh: Option<String>) -> Result<serde_json::Value, String> {
    Ok(crate::ipc::get_tree(&s, refresh.unwrap_or_default()).await)
}
#[tauri::command]
pub async fn api_refresh_cache(s: Srv<'_>) -> Result<serde_json::Value, String> {
    crate::ipc::refresh_cache(&s).await
}

// 文件 CRUD（3）
#[tauri::command]
pub async fn api_list_files(s: Srv<'_>) -> Result<serde_json::Value, String> {
    Ok(crate::ipc::list_files(&s).await)
}
#[tauri::command]
pub async fn api_read_file(s: Srv<'_>, path: String) -> Result<serde_json::Value, String> {
    crate::ipc::read_file(&s, path).await
}
#[tauri::command]
pub async fn api_save_file(s: Srv<'_>, path: String, content: String) -> Result<serde_json::Value, String> {
    crate::ipc::save_file_raw(&s, path, content).await
}
#[tauri::command]
pub async fn api_delete_file(s: Srv<'_>, path: String) -> Result<serde_json::Value, String> {
    crate::ipc::delete_file(&s, path).await
}

// 文档 API（6）
#[tauri::command]
pub async fn api_get_doc(s: Srv<'_>, path: String, force: Option<String>) -> Result<serde_json::Value, String> {
    crate::ipc::get_doc(&s, path, force).await
}
#[tauri::command]
pub async fn api_check_doc(s: Srv<'_>, path: String) -> Result<serde_json::Value, String> {
    crate::ipc::check_doc(&s, path).await
}
#[tauri::command]
pub async fn api_save_doc(
    s: Srv<'_>, path: String, content: String, base_hash: Option<String>,
) -> Result<serde_json::Value, String> {
    crate::ipc::save_doc(&s, path, content, base_hash).await
}
#[tauri::command]
pub async fn api_delete_docs(s: Srv<'_>, path: serde_json::Value) -> Result<serde_json::Value, String> {
    crate::ipc::delete_docs(&s, path).await
}
#[tauri::command]
pub async fn api_create_folder(s: Srv<'_>, parent: String, name: String) -> Result<serde_json::Value, String> {
    crate::ipc::create_folder(&s, parent, name).await
}
#[tauri::command]
pub async fn api_create_document(s: Srv<'_>, parent: String, name: String) -> Result<serde_json::Value, String> {
    crate::ipc::create_document(&s, parent, name).await
}

// 搜索 / 图谱
#[tauri::command]
pub async fn api_search(s: Srv<'_>, q: String) -> Result<serde_json::Value, String> {
    Ok(crate::ipc::search(&s, q).await)
}
#[tauri::command]
pub async fn api_get_graph(s: Srv<'_>) -> Result<serde_json::Value, String> {
    Ok(crate::ipc::get_graph(&s).await)
}

// Move / Copy / Rename
#[tauri::command]
pub async fn api_move_entry(s: Srv<'_>, source: String, target_folder: String) -> Result<serde_json::Value, String> {
    crate::ipc::move_entry(&s, source, target_folder).await
}
#[tauri::command]
pub async fn api_copy_entry(s: Srv<'_>, source: String, target_folder: String) -> Result<serde_json::Value, String> {
    crate::ipc::copy_entry(&s, source, target_folder).await
}
#[tauri::command]
pub async fn api_rename_entry(s: Srv<'_>, path: String, new_name: String) -> Result<serde_json::Value, String> {
    crate::ipc::rename_entry(&s, path, new_name).await
}

// Frontmatter（3）
#[tauri::command]
pub async fn api_get_frontmatter(s: Srv<'_>, path: String) -> Result<serde_json::Value, String> {
    crate::ipc::get_frontmatter(&s, path).await
}
#[tauri::command]
pub async fn api_preview_frontmatter(
    s: Srv<'_>, path: String, metadata: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    crate::ipc::preview_frontmatter(&s, path, metadata).await
}
#[tauri::command]
pub async fn api_apply_frontmatter(
    s: Srv<'_>, path: String, metadata: Option<serde_json::Value>,
    base_hash: String, confirmed: Option<bool>,
) -> Result<serde_json::Value, String> {
    crate::ipc::apply_frontmatter(&s, path, metadata, base_hash, confirmed).await
}

// 系统操作（3）
#[tauri::command]
pub async fn api_open_folder(path: String) -> Result<serde_json::Value, String> {
    Ok(crate::ipc::open_folder(path).await)
}
#[tauri::command]
pub async fn api_open_url(url: String) -> Result<serde_json::Value, String> {
    crate::ipc::open_url(url).await
}
#[tauri::command]
pub async fn api_browse_folder() -> Result<serde_json::Value, String> {
    Ok(crate::ipc::browse_folder().await)
}

// 授权（4）
#[tauri::command]
pub async fn api_license_status(s: Srv<'_>) -> Result<serde_json::Value, String> {
    Ok(crate::ipc::license_status(&s).await)
}
#[tauri::command]
pub async fn api_license_check(s: Srv<'_>) -> Result<serde_json::Value, String> {
    Ok(crate::ipc::license_check(&s).await)
}
#[tauri::command]
pub async fn api_license_activate(s: Srv<'_>, license_key: String) -> Result<serde_json::Value, String> {
    crate::ipc::license_activate(&s, license_key).await
}
#[tauri::command]
pub async fn api_license_deactivate(s: Srv<'_>) -> Result<serde_json::Value, String> {
    Ok(crate::ipc::license_deactivate(&s).await)
}

} // pub mod tauri_cmdmd
