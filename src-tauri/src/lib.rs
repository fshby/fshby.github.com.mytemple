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

/// 检查授权状态
pub async fn cmd_license_status(data_root: &std::path::Path) -> license::LicenseStatus {
    license::get_license_status(data_root)
}

/// 验证授权码
pub async fn cmd_verify_license(
    license_key: &str,
    data_root: &std::path::Path,
) -> license::LicenseResult {
    license::verify_license(license_key, data_root)
}

/// 获取机器码
pub async fn cmd_machine_code() -> String {
    license::get_machine_code()
}

/// 读取文件内容
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
