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
pub mod license;
pub mod rag;
pub mod server;
pub mod utils;

use serde::{Deserialize, Serialize};
use std::fs as stdfs;
use std::path::PathBuf;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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
            tauri_cmd::cmd_export_save_as,
            tauri_cmd::cmd_open_exported_file,
            tauri_cmd::cmd_reveal_exported_file_in_folder,
            tauri_cmd::cmd_import_pick_files,
            tauri_cmd::cmd_import_read_file,
        ])
        .setup(move |app| -> Result<(), Box<dyn std::error::Error>> {
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
                let axum_home = format!("http://127.0.0.1:{}/", real_port);
                let axum_splash = format!("http://127.0.0.1:{}/splash.html", real_port);
                log::info!("[boot] axum 真实端口 {} (请求 {})，splash={}", real_port, requested_port, axum_splash);
                let splash_url = axum_splash.clone();
                let home_url = axum_home.clone();

                // 2) 轮询 axum 端口就绪（使用真实端口）
                let addr = format!("127.0.0.1:{}", real_port);
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                let mut ready = false;
                while std::time::Instant::now() < deadline {
                    if tokio::net::TcpStream::connect(&addr).await.is_ok() {
                        ready = true;
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                }

                if !ready {
                    log::error!("[boot] axum 30 秒内未启动");
                    let html = format!(r#"
                    <div style="color:#fecaca;text-align:center;padding:48px 24px;font-family:sans-serif;background:#3d3830;">
                      <h2>启动失败：本地服务无法启动</h2>
                      <p>端口 {} 连续 30 秒无法连通。请关闭占用该端口的软件，或设置环境变量 MYTEMPLE_PORT 为 7322~7420 之间任一空闲端口后重试。</p>
                      <p style="color:#fbbf24;">若启动后显示 HTTP ERROR 404，请不要手动打开 Edge 浏览器访问 127.0.0.1；应直接使用桌面窗口的「卸载后重新安装」的方法获取最新版修复。</p>
                    </div>"#, real_port);
                    let escaped = html.replace('\'', "\\'").replace("script", "scr\\ipt");
                    let _ = window_clone.eval(&format!("document.body.innerHTML = '{}';", escaped));
                    return;
                }

                // 3) 加载真实 splash.html（通过 navigate，与源程序一致：boot.webp 背景 + 进度条）
                match url::Url::parse(&splash_url) {
                    Ok(parsed) => {
                        if let Err(e) = window_clone.navigate(parsed) {
                            log::warn!("[boot] splash navigate 失败 {:?}，改用 eval 兜底", e);
                            let _ = window_clone.eval(&format!("document.location.href = {:?};", splash_url));
                        }
                    }
                    Err(e) => log::error!("[boot] splash URL 解析失败: {}", e),
                }

                // 等待 splash.html DOM 就绪（让进度条元素可被 eval 找到）
                // 给约 150ms 让 boot.webp 网络请求 & 渲染，然后 show 窗口（避免白屏）
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
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

                // 4c) 短暂收尾，给进度条动画完成
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let _ = window_clone.eval(&update_progress(95, "即将完成…"));
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                let _ = window_clone.eval(&update_progress(100, "加载完成"));
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;

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

// ── 导出：原生「另存为」对话框 + 真实文件写入（返回保存成功的完整路径） ──

/// 前端传入「默认文件名 + 扩展名过滤 + 文件字节 base64」→ 弹出系统原生 Save As 对话框 →
/// 选路径后写磁盘 → 返回保存成功的绝对路径字符串（用户取消返回 null）。
/// 路径必须"用户明确确认"的才能写（不能写到系统目录），符合需求「清晰知道导出位置」。
#[tauri::command]
pub async fn cmd_export_save_as(
    app: tauri::AppHandle,
    default_name: String,
    extensions: Vec<String>,
    data_base64: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // 1) decode base64 → Vec<u8>
    let bytes = base64_decode_for_tauri(&data_base64).map_err(|e| format!("解码导出字节失败: {}", e))?;

    // 2) 构建 filters：extensions 每个就是扩展名（不含点）
    let name_hint = if default_name.trim().is_empty() {
        "未命名".to_string()
    } else {
        default_name.trim().to_string()
    };
    // 确保扩展名去点 + 小写
    let exts: Vec<String> = extensions
        .iter()
        .map(|s| s.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let dialog_label = if exts.is_empty() {
        "文件".to_string()
    } else {
        exts.iter()
            .map(|s| s.to_ascii_uppercase())
            .collect::<Vec<_>>()
            .join("/")
            + " 文件"
    };

    // 3) 用 tauri_plugin_dialog 构建 FileSaveDialog
    //    Tauri 2.x dialog 是回调模式，用 oneshot bridge 到 async
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<std::path::PathBuf>>();
    let mut tx_opt = Some(tx);
    // add_filter 要求 &[&str]，把 String 转成 ref 切片
    let star: String = "*".to_string();
    let filter_exts: Vec<&str> = if exts.is_empty() {
        vec![&star]
    } else {
        exts.iter().map(|s| s.as_str()).collect()
    };
    let mut builder = app
        .dialog()
        .file()
        .set_title("另存为 — MyTemple Knowledge")
        .set_file_name(&name_hint)
        .add_filter(dialog_label, &filter_exts);
    // 若无扩展名过滤器，再额外加一个"所有文件"兜底
    if !exts.is_empty() {
        let all: &[&str] = &["*"];
        builder = builder.add_filter("所有文件", all);
    }
    builder.save_file(move |path_opt: Option<tauri_plugin_dialog::FilePath>| {
        if let Some(tx) = tx_opt.take() {
            let converted = path_opt.and_then(|fp| fp.into_path().ok());
            let _ = tx.send(converted);
        }
    });
    let chosen = tokio::time::timeout(std::time::Duration::from_secs(600), rx)
        .await
        .map_err(|_| "「另存为」对话框长时间未响应".to_string())?
        .unwrap_or(None);

    let Some(path) = chosen else {
        // 用户取消
        return Ok(None);
    };

    // 4) 写文件（create 会覆盖）
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败 {}: {}", parent.display(), e))?;
    }
    std::fs::write(&path, &bytes).map_err(|e| format!("写入文件 {} 失败: {}", path.display(), e))?;

    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn cmd_open_exported_file(app: tauri::AppHandle, path: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    let p = std::path::Path::new(path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("打开文件失败: {}", e))
}

#[tauri::command]
pub async fn cmd_reveal_exported_file_in_folder(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    let p = std::path::Path::new(path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    #[cfg(target_os = "windows")]
    {
        // Explorer /select,<path> 选中对应文件
        let abs = std::fs::canonicalize(p).map_err(|e| format!("路径解析失败: {}", e))?;
        std::process::Command::new("explorer.exe")
            .args(["/select,", &abs.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {}", e))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &p.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {}", e))?;
        return Ok(());
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        // Linux: 打开父目录
        if let Some(parent) = p.parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("打开目录失败: {}", e))?;
        }
        Ok(())
    }
}

// ── 导入：原生「打开文件」对话框 + 读各种格式内容返回给前端 ──

/// 前端点击「导入」弹出系统原生多选「打开文件」，返回用户选中的绝对路径列表。
/// 不直接返回文件内容（docx 等大文件可能上百 MB 不适合一次传输），路径交给 cmd_import_read_file 分文件读。
#[tauri::command]
pub async fn cmd_import_pick_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Vec<std::path::PathBuf>>();
    let mut tx_opt = Some(tx);
    let supported: &[&str] = &[
        "md", "markdown", "txt", "html", "htm", "json",
        "docx", "doc", "rtf", "odt", "csv",
    ];
    let all: &[&str] = &["*"];
    app.dialog()
        .file()
        .set_title("选择要导入的文档 — MyTemple Knowledge")
        .add_filter("支持的文档", supported)
        .add_filter("所有文件", all)
        .pick_files(move |paths_opt: Option<Vec<tauri_plugin_dialog::FilePath>>| {
            if let Some(tx) = tx_opt.take() {
                let list = paths_opt
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|fp| fp.into_path().ok())
                    .collect::<Vec<_>>();
                let _ = tx.send(list);
            }
        });
    let paths = tokio::time::timeout(std::time::Duration::from_secs(600), rx)
        .await
        .map_err(|_| "「打开文件」对话框长时间未响应".to_string())?
        .unwrap_or_default();
    Ok(paths.iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

/// 按用户已选择的本地绝对路径读一个文件 → 返回 { ext, bytes_base64, text_utf8_or_null }
/// MD/TXT/HTML/JSON/CSV 文本格式：读 UTF-8 文本字段；DOCX/DOC/RTF/ODT 二进制格式：
/// 返回 bytes_base64 字段由前端 mammoth/转换逻辑处理（Rust 侧同时附带 docx 最小文本提取兜底）。
#[derive(serde::Serialize)]
pub struct ImportReadResult {
    path: String,
    name: String,
    ext: String,
    size: u64,
    text: Option<String>,
    bytes_base64: Option<String>,
    /// Rust 侧做的二进制格式最小 Markdown 提取（docx/docx/rtf 文本内容），前端优先使用。
    converted_markdown: Option<String>,
}
#[tauri::command]
pub async fn cmd_import_read_file(path: &str) -> Result<ImportReadResult, String> {
    let p = std::path::Path::new(path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    let metadata = std::fs::metadata(p).map_err(|e| format!("读取元数据失败: {}", e))?;
    if metadata.len() > 50 * 1024 * 1024 {
        return Err("文件超过 50MB，已跳过".to_string());
    }
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "未命名".to_string());
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase().to_owned())
        .unwrap_or_default();

    let text_exts = ["md", "markdown", "txt", "html", "htm", "json", "csv", "xml"];
    let is_text = text_exts.iter().any(|e| e == &ext);

    let bytes = std::fs::read(p).map_err(|e| format!("读取文件失败: {}", e))?;

    let text = if is_text {
        Some(String::from_utf8_lossy(&bytes).into_owned())
    } else {
        None
    };

    // Rust 侧兜底二进制格式转换：前端 mammoth 没装好 / 没网时也能导入正文
    let converted_markdown = match ext.as_str() {
        "docx" => extract_docx_markdown(&bytes, &name).ok(),
        "rtf" => extract_rtf_markdown(&bytes, &name).ok(),
        "odt" => extract_odt_markdown(&bytes, &name).ok(),
        _ => None,
    };

    // bytes_base64 只有对"非文本的大格式"才传，避免 50MB 都走 IPC，
    // 但 docx/rtf/odt 需要给前端 mammoth 备用，因此如果 converted_markdown 已生成可不传
    let need_raw_bytes = !is_text && converted_markdown.is_none() && matches!(ext.as_str(), "docx" | "odt" | "rtf");
    let bytes_base64 = if need_raw_bytes {
        Some(base64_encode_for_tauri(&bytes))
    } else {
        None
    };

    Ok(ImportReadResult {
        path: path.to_string(),
        name,
        ext,
        size: metadata.len(),
        text,
        bytes_base64,
        converted_markdown,
    })
}

// ── helpers ──

fn base64_decode_for_tauri(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s.trim().replace([' ', '\n', '\r', '\t'], ""))
        .map_err(|e| e.to_string())
}
fn base64_encode_for_tauri(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// docx 最小正文提取：docx 是 ZIP；word/document.xml 里 <w:p>=段落 / <w:t>=文本 / <w:tbl>=表格。
/// 输出 Markdown（按段落换行、表格用竖线拼 +--+--+ 简化、标题抓 outlineLvl）
fn extract_docx_markdown(bytes: &[u8], fallback_title: &str) -> anyhow::Result<String> {
    use std::io::Cursor;
    let reader = Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(reader)?;
    let xml = {
        let mut f = zip.by_name("word/document.xml")?;
        let mut s = String::with_capacity(f.size() as usize);
        std::io::Read::read_to_string(&mut f, &mut s)?;
        s
    };
    // 简单基于字符串扫描（不用 xmltree 免加依赖）：先移除所有 xml 命名空间前缀方便处理
    let mut doc = String::new();
    doc.push_str(&format!("# {}\n\n", fallback_title));

    // 逐段 <w:p ...>...</w:p>
    let mut i = 0;
    let bytes_s = xml.as_bytes();
    while i < bytes_s.len() {
        if !starts_at(bytes_s, i, b"<w:p") {
            i += 1;
            continue;
        }
        let end = find_tag_close(bytes_s, i, b"w:p").ok_or_else(|| anyhow::anyhow!("docx w:p not closed"))?;
        let seg = &xml[i..end];
        // 段落文本 = 所有 <w:t>..</w:t> 文本
        let mut para_text = String::new();
        let mut j = 0;
        let seg_bytes = seg.as_bytes();
        while let Some(topen) = find_tag_open(seg_bytes, j, b"w:t") {
            let tstart = seg_bytes[topen..]
                .iter()
                .position(|&b| b == b'>')
                .map(|p| topen + p + 1)
                .unwrap_or(topen);
            if let Some(tclose) = find_tag_close(seg_bytes, tstart, b"w:t") {
                para_text.push_str(&seg[tstart..tclose]);
                j = tclose + 6; // </w:t> len
            } else {
                break;
            }
        }
        doc.push_str(&para_text);
        doc.push('\n');
        i = end + 6; // </w:p> len
    }
    // 压缩过密空行
    let cleaned = collapse_blank_lines(&doc);
    Ok(cleaned)
}

fn extract_rtf_markdown(bytes: &[u8], fallback_title: &str) -> anyhow::Result<String> {
    let text = String::from_utf8_lossy(bytes).into_owned();
    // 最简 RTF 文本提取：
    //   - 去掉 { ... } 组（简单基于层级）
    //   - 去掉 \controlword 或 \'xx 十六进制（cp1252 UTF-8 转义这里用简单 drop，保证至少不 crash）
    let mut out = String::with_capacity(text.len());
    let mut depth = 0i32;
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '{' => {
                depth += 1;
                i += 1;
                continue;
            }
            '}' => {
                depth = (depth - 1).max(0);
                i += 1;
                continue;
            }
            '\\' if depth == 0 => {
                // 遇到控制字：吃掉直到空格或特殊字符；\'xx 或 \udxxx 我们直接跳过
                i += 1;
                // \* 忽略标记
                if i < chars.len() && chars[i] == '*' {
                    i += 1;
                    continue;
                }
                if i < chars.len() && chars[i] == '\'' {
                    i += 3; // skip 'xx
                    continue;
                }
                // 数字控制字
                while i < chars.len() && chars[i].is_ascii_alphabetic() {
                    i += 1;
                }
                while i < chars.len() && (chars[i] == '-' || chars[i].is_ascii_digit()) {
                    i += 1;
                }
                // 控制字结尾如果是 ' ' 代表终止符，跳过空格
                if i < chars.len() && chars[i] == ' ' {
                    i += 1;
                }
                continue;
            }
            '\x0d' | '\x0a' => {
                i += 1;
                continue;
            }
            _ => {
                if depth == 0 {
                    out.push(c);
                }
                i += 1;
            }
        }
    }
    let cleaned = collapse_blank_lines(&format!("# {}\n\n{}", fallback_title, out));
    Ok(cleaned)
}

fn extract_odt_markdown(bytes: &[u8], fallback_title: &str) -> anyhow::Result<String> {
    use std::io::Cursor;
    let reader = Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(reader)?;
    let xml = {
        let mut f = zip.by_name("content.xml")?;
        let mut s = String::with_capacity(f.size() as usize);
        std::io::Read::read_to_string(&mut f, &mut s)?;
        s
    };
    let mut doc = format!("# {}\n\n", fallback_title);
    let bytes_s = xml.as_bytes();
    let mut i = 0;
    let para_tags: [&[u8]; 2] = [b"text:p", b"text:h"];
    while i < bytes_s.len() {
        let mut matched: Option<&[u8]> = None;
        for tag in para_tags.iter().copied() {
            let open = format!("<{}", std::str::from_utf8(tag).unwrap()).into_bytes();
            if starts_at(bytes_s, i, &open) {
                matched = Some(tag);
                break;
            }
        }
        if let Some(tag) = matched {
            if let Some(end) = find_tag_close(bytes_s, i, tag) {
                let seg = &xml[i..end];
                let text = strip_inner_tags(seg);
                doc.push_str(&text);
                doc.push('\n');
                i = end + 3 + tag.len(); // </tag>
                continue;
            }
        }
        i += 1;
    }
    Ok(collapse_blank_lines(&doc))
}

fn starts_at(hay: &[u8], at: usize, needle: &[u8]) -> bool {
    if at + needle.len() > hay.len() {
        return false;
    }
    &hay[at..at + needle.len()] == needle
}
fn find_tag_open(hay: &[u8], from: usize, tag: &[u8]) -> Option<usize> {
    let pat: Vec<u8> = format!("<{}", std::str::from_utf8(tag).unwrap()).into_bytes();
    (from..hay.len()).find(|&i| starts_at(hay, i, &pat))
}
fn find_tag_close(hay: &[u8], from: usize, tag: &[u8]) -> Option<usize> {
    let close_pat: Vec<u8> = format!("</{}>", std::str::from_utf8(tag).unwrap()).into_bytes();
    (from..hay.len()).find(|&i| starts_at(hay, i, &close_pat))
}
fn strip_inner_tags(seg: &str) -> String {
    let bytes = seg.as_bytes();
    let mut out = String::with_capacity(seg.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // 跳过直到 '>'
            while i < bytes.len() && bytes[i] != b'>' {
                i += 1;
            }
            if i < bytes.len() {
                i += 1;
            }
            continue;
        }
        // xml entities 简单还原 < > &
        if starts_at(bytes, i, b"&lt;") {
            out.push('<');
            i += 4;
            continue;
        }
        if starts_at(bytes, i, b"&gt;") {
            out.push('>');
            i += 4;
            continue;
        }
        if starts_at(bytes, i, b"&amp;") {
            out.push('&');
            i += 5;
            continue;
        }
        if starts_at(bytes, i, b"&apos;") {
            out.push('\'');
            i += 6;
            continue;
        }
        if starts_at(bytes, i, b"&quot;") {
            out.push('"');
            i += 6;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}
fn collapse_blank_lines(s: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut prev_blank = false;
    for line in s.lines() {
        let blank = line.trim().is_empty();
        if blank && prev_blank {
            continue;
        }
        prev_blank = blank;
        out.push(line.to_string());
    }
    out.join("\n").trim().to_string()
}

} // pub mod tauri_cmd
