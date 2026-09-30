// ipc.rs - shared service layer (axum HTTP + Tauri IPC)
use crate::server::ServerState;
use serde::Serialize;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Serialize)]
struct ApiResponse<T: Serialize> {
    ok: bool,
    data: Option<T>,
    error: Option<String>,
}

fn success<T: Serialize>(data: T) -> serde_json::Value {
    serde_json::to_value(&ApiResponse { ok: true, data: Some(data), error: None })
        .unwrap_or_else(|_| serde_json::json!({ "ok": true, "data": null }))
}
fn err(msg: impl Into<String>) -> String { msg.into() }
fn bool_flag(s: &str) -> bool { s == "1" || s.eq_ignore_ascii_case("true") }

// 1. Health / meta
pub async fn health() -> serde_json::Value { serde_json::json!({ "status": "ok" }) }

/// 知识脉络健康度分析（GET /api/knowledge/health?days=N）
///
/// 语义对齐旧 Node 实现（server.js:2332-2410，2026-09-28 大清理时随 Node 后端一并删除）：
///   - missingTags  文档没有标签，或仅有占位标签「待分类」
///   - missingLinks 文档没有任何真实链接（`link` 边，即 [[wiki]] / 相对路径 .md）的出链或入链
///   - staleDocs    超过 `days` 天未浏览；没有任何浏览记录视为“从未浏览”
///   - 概念关联     文档未与任何语义关键词（`keyword` 边）相连
/// 评分满分 100：链接 40 / 标签 30 / 活跃 20 / 概念 10，各维度比率 = (总数 - 命中数) / 总数。
///
/// 注意：`tag` / `missing` / `keyword` 边都参与节点度计算，所以不能用图谱的 `orphan`
/// 字段代替“缺链接”——必须单独统计 `link` 边度数（与旧实现 outgoingLinks/backlinks 一致）。
pub async fn knowledge_health(s: &ServerState, days: u32) -> serde_json::Value {
    let days = days.clamp(1, 365);
    let now = chrono::Utc::now().timestamp_millis() as u64;
    let cutoff = now.saturating_sub(days as u64 * 86_400_000);

    let files = s.app.get_files().await;
    let gf = to_graph_files(s, &files).await;
    let graph = crate::utils::build_graph(&gf);

    let mut link_degree: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    let mut concept_degree: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for e in &graph.edges {
        let bucket = match e.edge_type.as_str() {
            "link" => &mut link_degree,
            "keyword" => &mut concept_degree,
            _ => continue,
        };
        *bucket.entry(e.source.as_str()).or_insert(0) += 1;
        *bucket.entry(e.target.as_str()).or_insert(0) += 1;
    }

    s.app.doc_views.ensure_loaded().await.ok();
    let views = s.app.doc_views.snapshot();

    let mut missing_tags: Vec<serde_json::Value> = Vec::new();
    let mut missing_links: Vec<serde_json::Value> = Vec::new();
    let mut stale_docs: Vec<serde_json::Value> = Vec::new();
    let mut docs_no_concepts: usize = 0;

    for f in &files {
        let tags = s.app.token_dict.lookup_many(&f.tags);
        let only_pending = tags.len() == 1 && tags[0] == "待分类";
        if tags.is_empty() || only_pending {
            missing_tags.push(doc_ref(f));
        }
        if link_degree.get(f.path.as_str()).copied().unwrap_or(0) == 0 {
            missing_links.push(doc_ref(f));
        }
        if concept_degree.get(f.path.as_str()).copied().unwrap_or(0) == 0 {
            docs_no_concepts += 1;
        }
        let viewed_at = views.get(&f.path).map(|v| v.viewed_at).unwrap_or(0);
        if viewed_at == 0 || viewed_at < cutoff {
            let mut item = doc_ref(f);
            item["viewedAt"] = serde_json::json!(viewed_at);
            item["daysSince"] = serde_json::json!(if viewed_at == 0 {
                -1i64
            } else {
                ((now.saturating_sub(viewed_at)) / 86_400_000) as i64
            });
            stale_docs.push(item);
        }
    }
    // 最久未浏览的排最前（与旧实现一致：从未浏览 viewedAt=0 会排最前）
    stale_docs.sort_by_key(|d| d.get("viewedAt").and_then(|v| v.as_u64()).unwrap_or(0));

    let total = files.len();
    let ratio = |count: usize| -> f64 {
        if total == 0 { 0.0 } else { ((total as f64 - count as f64) / total as f64).clamp(0.0, 1.0) }
    };
    let link_score = (ratio(missing_links.len()) * 40.0).round() as i64;
    let tag_score = (ratio(missing_tags.len()) * 30.0).round() as i64;
    let fresh_score = (ratio(stale_docs.len()) * 20.0).round() as i64;
    let concept_score = (ratio(docs_no_concepts) * 10.0).round() as i64;
    let health_score = (link_score + tag_score + fresh_score + concept_score).clamp(0, 100);

    serde_json::json!({
        "days": days,
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "stats": {
            "documents": total,
            "missingTags": missing_tags.len(),
            "missingLinks": missing_links.len(),
            "staleDocs": stale_docs.len(),
            "healthScore": health_score,
            "scoreBreakdown": {
                "link": { "score": link_score, "max": 40, "label": "链接密度" },
                "tag": { "score": tag_score, "max": 30, "label": "标签覆盖" },
                "fresh": { "score": fresh_score, "max": 20, "label": "知识活跃" },
                "concept": { "score": concept_score, "max": 10, "label": "概念关联" },
            },
        },
        "missingTags": missing_tags.into_iter().take(200).collect::<Vec<_>>(),
        "missingLinks": missing_links.into_iter().take(200).collect::<Vec<_>>(),
        "staleDocs": stale_docs.into_iter().take(200).collect::<Vec<_>>(),
    })
}

/// 文档条目（知识脉络列表项）
fn doc_ref(f: &crate::app::FileEntry) -> serde_json::Value {
    serde_json::json!({
        "path": f.path,
        "title": f.title,
        "workspace": f.workspace_name,
    })
}

/// FileEntry → GraphFile（图谱与知识脉络共用的输入转换）
///
/// `FileEntry.content` 是懒加载的（scan_workspace 时为 None），而解析 `[[wikilink]]`
/// 必须要有真实正文，否则所有文档都会因为没有边而被算成“缺链接”。因此对 content 为
/// None 的文件触发 `read_file_force` 磁盘读取（成功会回填缓存，后续调用即命中内存），
/// 失败则用空字符串兜底，不影响其他文档。
async fn to_graph_files(s: &ServerState, files: &[crate::app::FileEntry]) -> Vec<crate::utils::GraphFile> {
    let mut out: Vec<crate::utils::GraphFile> = Vec::with_capacity(files.len());
    for x in files.iter() {
        let content = match x.content.as_deref() {
            Some(c) => c.to_string(),
            None => match s.app.read_file_force(&x.path).await {
                Ok(e) => e.content.clone().unwrap_or_default(),
                Err(_) => String::new(),
            },
        };
        let terms = s.app.token_dict.lookup_many(&x.terms)
            .into_iter().map(|t| crate::utils::TermCount { term: t, count: 1 }).collect();
        out.push(crate::utils::GraphFile {
            path: x.path.clone(),
            relative: x.path.clone(),
            title: x.title.clone(),
            content,
            tags: s.app.token_dict.lookup_many(&x.tags),
            terms,
            workspace_id: x.workspace_id.clone(),
            workspace_name: Some(x.workspace_name.clone()),
            modified: x.modified,
        });
    }
    out
}
pub async fn get_version(refresh: &str) -> serde_json::Value {
    use super::handlers::fetch_remote_version_pub;
    if bool_flag(refresh) { if let Ok(r) = fetch_remote_version_pub().await { return r; } }
    read_local_version_json()
}

/// 读取本地 version.json 并返回完整 JSON（多路径查找，与关于页一致）
pub fn read_local_version_json() -> serde_json::Value {
    let m = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    // 1) 开发环境：<manifest>/../version.json（项目根目录）
    if let Some(p) = m.parent().map(|p| p.join("version.json")) { candidates.push(p); }
    // 2) 打包资源目录：<exe>/resources/version.json（Tauri 安装后）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("resources").join("version.json"));
            candidates.push(exe_dir.join("version.json"));
        }
    }
    for vp in &candidates {
        if let Ok(c) = std::fs::read_to_string(vp) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&c) {
                return v;
            }
        }
    }
    // 兜底：只有 Cargo.toml 中的版本号
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "name": "MyTemple Knowledge",
        "releaseDate": "",
        "latestReleaseNotes": "稳定版本"
    })
}

/// 读取本地 version.json 中的 version 字段（与关于页显示的版本号一致）
pub fn read_local_version_string() -> String {
    read_local_version_json()
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}
pub async fn get_system_paths() -> serde_json::Value {
    let h = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
    serde_json::json!({ "home": h, "appdata": std::env::var("APPDATA").unwrap_or_default(), "localAppData": std::env::var("LOCALAPPDATA").unwrap_or_default() })
}

// 2. Workspaces
pub async fn get_workspaces(s: &ServerState) -> serde_json::Value {
    let ws = s.app.get_workspaces().await;
    let def = s.app.get_default_workspace_id().await;
    let visible: Vec<crate::app::Workspace> = ws.iter().filter(|w| w.visible).take(2).cloned().collect();
    let mut recent = ws.clone(); recent.sort_by(|a,b| b.last_used.cmp(&a.last_used)); recent.truncate(8);
    serde_json::json!({ "workspaces": ws, "defaultWorkspaceId": def, "visible": visible, "recent": recent })
}
pub async fn add_workspace(s: &ServerState, path: String, name: Option<String>) -> Result<serde_json::Value, String> {
    Ok(success(s.app.add_workspace(&path, &name.unwrap_or_default()).await.map_err(|e| err(e.to_string()))?))
}
pub async fn remove_workspace(s: &ServerState, id: String) -> Result<serde_json::Value, String> {
    s.app.remove_workspace(&id).await.map_err(|e| err(e.to_string()))?;
    Ok(serde_json::json!({"ok":true}))
}
pub async fn rename_workspace(s: &ServerState, id: String, name: String) -> Result<serde_json::Value, String> {
    s.app.rename_workspace(&id, &name).await.map_err(|e| err(e.to_string()))?;
    Ok(serde_json::json!({"ok":true}))
}
pub async fn set_default_workspace(s: &ServerState, id: String) -> Result<serde_json::Value, String> {
    s.app.set_default_workspace(&id).await.map_err(|e| err(e.to_string()))?;
    Ok(serde_json::json!({"ok":true}))
}
pub async fn show_workspace(s: &ServerState, id: String, visible: Option<bool>) -> Result<serde_json::Value, String> {
    s.app.show_workspace(&id, visible.unwrap_or(true)).await.map_err(|e| err(e.to_string()))?;
    Ok(serde_json::json!({"ok":true}))
}
pub async fn set_md_only(s: &ServerState, id: String, md_only: Option<bool>) -> Result<serde_json::Value, String> {
    s.app.set_md_only(&id, md_only.unwrap_or(false)).await.map_err(|e| err(e.to_string()))?;
    Ok(serde_json::json!({"ok":true}))
}

// 3. Tree + refresh_cache
pub async fn get_tree(s: &ServerState, refresh: String) -> serde_json::Value {
    if bool_flag(&refresh) { if let Err(e) = s.app.refresh_cache().await { log::warn!("[get_tree ipc]: {}", e); } }
    let t = s.app.get_tree().await;
    let f = s.app.get_files().await;
    let ws = s.app.get_workspaces().await;
    let def = s.app.get_default_workspace_id().await;
    serde_json::json!({ "tree": t.children, "count": f.len(), "workspaces": ws, "defaultWorkspaceId": def })
}
pub async fn refresh_cache(s: &ServerState) -> Result<serde_json::Value, String> {
    s.app.refresh_cache().await.map_err(|e| err(e.to_string()))?;
    Ok(serde_json::json!({"ok":true}))
}

// 4. File CRUD
pub async fn list_files(s: &ServerState) -> serde_json::Value { success(s.app.get_files().await) }
pub async fn read_file(s: &ServerState, path: String) -> Result<serde_json::Value, String> {
    Ok(success(s.app.read_file(&path).await.map_err(|e| err(e.to_string()))?))
}
pub async fn save_file_raw(s: &ServerState, path: String, content: String) -> Result<serde_json::Value, String> {
    let h = s.app.save_file(&path, &content, None).await.map_err(|e| err(e.to_string()))?;
    Ok(success(serde_json::json!({"sha256": h})))
}
pub async fn delete_file(s: &ServerState, path: String) -> Result<serde_json::Value, String> {
    s.app.delete_file(&path).await.map_err(|e| err(e.to_string()))?;
    Ok(success(serde_json::json!({})))
}
pub async fn get_doc(s: &ServerState, path: String, force: Option<String>) -> Result<serde_json::Value, String> {
    let fr = force.as_deref().map(|x| bool_flag(x)).unwrap_or(false);
    let e = (if fr { s.app.read_file_force(&path).await } else { s.app.read_file(&path).await }).map_err(|e| err(e.to_string()))?;
    // 记录浏览时间：知识脉络「待温习」维度的唯一数据源（沿用旧 server.js 在 /api/doc 里
    // docViews.record() 的时机）。持久化失败不影响阅读主流程，故忽略错误。
    s.app.doc_views.record(&e.path).await.ok();
    Ok(serde_json::json!({"path":e.path,"title":e.title,"content":e.content.unwrap_or_default(),"tags":s.app.token_dict.lookup_many(&e.tags),"terms":s.app.token_dict.lookup_many(&e.terms),"encoding":e.encoding,"contentSha256":e.content_sha256,"created":e.created,"modified":e.modified}))
}
pub async fn check_doc(s: &ServerState, path: String) -> Result<serde_json::Value, String> {
    let (h,m) = s.app.check_file(&path).await.map_err(|e| err(e.to_string()))?;
    Ok(serde_json::json!({"path":path,"sha256":h,"modified":m}))
}
pub async fn save_doc(s: &ServerState, path: String, content: String, base_hash: Option<String>) -> Result<serde_json::Value, String> {
    match s.app.save_file(&path, &content, base_hash.as_deref()).await {
        Ok(h) => Ok(serde_json::json!({"ok":true,"path":path,"contentSha256":h})),
        Err(e) => {
            let m = e.to_string();
            if m.starts_with("__CONFLICT__:") {
                Ok(serde_json::json!({"ok":false,"conflict":true,"path":path,"diskSha256":m.trim_start_matches("__CONFLICT__:"),"message":"文件已被外部编辑器修改，保存将被覆盖。是否继续？"}))
            } else { Err(err(m)) }
        }
    }
}
pub async fn delete_docs(s: &ServerState, paths: serde_json::Value) -> Result<serde_json::Value, String> {
    let paths: Vec<String> = match paths {
        serde_json::Value::String(x) => vec![x],
        serde_json::Value::Array(arr) => arr.into_iter().filter_map(|v| v.as_str().map(|s| s.into())).collect(),
        _ => return Err(err("path must be a string or array")),
    };
    let mut errs = Vec::new();
    for p in &paths { if let Err(e) = s.app.delete_file(p).await { errs.push(format!("{}: {}", p, e)); } }
    if errs.is_empty() { Ok(serde_json::json!({"ok":true})) } else { Err(err(errs.join("; "))) }
}
pub async fn create_folder(s: &ServerState, parent: String, name: String) -> Result<serde_json::Value, String> {
    let p = s.app.create_folder(&parent, &name).await.map_err(|e| err(e.to_string()))?;
    Ok(serde_json::json!({"ok":true,"path":p}))
}
pub async fn create_document(s: &ServerState, parent: String, name: String) -> Result<serde_json::Value, String> {
    let (p,h) = s.app.create_doc(&parent, &name).await.map_err(|e| err(e.to_string()))?;
    Ok(serde_json::json!({"ok":true,"path":p,"contentSha256":h}))
}

// 5. Search + Graph
pub async fn search(s: &ServerState, q: String, offset: usize, limit: usize) -> serde_json::Value {
    let mut results = s.app.search(&q).await;
    let total = results.len();
    let end = (offset + limit).min(total);
    let visible: Vec<_> = results.drain(..end).skip(offset).collect();
    serde_json::json!({
        "results": visible,
        "total": total,
        "offset": offset,
        "limit": limit
    })
}
pub async fn get_graph(s: &ServerState) -> serde_json::Value {
    let f = s.app.get_files().await;
    // 图谱构建需要真实正文（解析 [[wikilink]] 产生 link 边），转换逻辑见 to_graph_files
    let gf = to_graph_files(s, &f).await;
    serde_json::to_value(crate::utils::build_graph(&gf)).unwrap_or(serde_json::json!({"nodes":[],"edges":[]}))
}

// 6. Move/Copy/Rename
pub async fn move_entry(s: &ServerState, source: String, target_folder: String) -> Result<serde_json::Value, String> {
    let (p,d) = s.app.move_entry(&source, &target_folder).await.map_err(|e| err(e.to_string()))?;
    Ok(serde_json::json!({"ok":true,"from":source,"path":p,"type":if d {"folder"}else{"file"}}))
}
pub async fn copy_entry(s: &ServerState, source: String, target_folder: String) -> Result<serde_json::Value, String> {
    let p = s.app.copy_entry(&source, &target_folder).await.map_err(|e| err(e.to_string()))?;
    Ok(serde_json::json!({"ok":true,"path":p}))
}
pub async fn rename_entry(s: &ServerState, path: String, new_name: String) -> Result<serde_json::Value, String> {
    let np = s.app.rename_entry(&path, &new_name).await.map_err(|e| err(e.to_string()))?;
    Ok(serde_json::json!({"ok":true,"newPath":np}))
}

// 7. Frontmatter
pub async fn get_frontmatter(s: &ServerState, path: String) -> Result<serde_json::Value, String> {
    Ok(s.app.get_frontmatter(&path).await.map_err(|e| err(e.to_string()))?)
}
pub async fn preview_frontmatter(s: &ServerState, path: String, metadata: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let md = metadata.unwrap_or_else(|| serde_json::json!({}));
    Ok(s.app.preview_frontmatter(&path, &md).await.map_err(|e| err(e.to_string()))?)
}
pub async fn apply_frontmatter(s: &ServerState, path: String, metadata: Option<serde_json::Value>, base_hash: String, confirmed: Option<bool>) -> Result<serde_json::Value, String> {
    if confirmed != Some(true) { return Err(err("Confirmation required")); }
    let md = metadata.unwrap_or_else(|| serde_json::json!({}));
    Ok(s.app.apply_frontmatter(&path, &md, &base_hash).await.map_err(|e| err(e.to_string()))?)
}

// 8. License
const LICENSE_FN: &str = ".license";
fn license_path(d: &std::path::Path) -> std::path::PathBuf { d.join(LICENSE_FN) }
fn read_license(d: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(license_path(d)).ok().map(|s| s.trim().into()).filter(|s: &String| !s.is_empty())
}
pub async fn license_status(s: &ServerState) -> serde_json::Value {
    serde_json::to_value(crate::license::get_license_status(&s.app.data_root)).unwrap_or_default()
}
pub async fn license_check(s: &ServerState) -> serde_json::Value {
    let dr = s.app.data_root.clone(); let mc = crate::license::get_machine_code();
    match read_license(&dr) {
        None => serde_json::json!({"activated":false,"machineCode":mc}),
        Some(k) => {
            let r = crate::license::verify_license(&k, &dr);
            let mut obj = serde_json::to_value(&r).unwrap_or_default();
            if let Some(m) = obj.as_object_mut() { m.insert("activated".into(), serde_json::Value::Bool(r.valid)); }
            obj
        }
    }
}
pub async fn license_activate(s: &ServerState, license_key: String) -> Result<serde_json::Value, String> {
    let k = license_key.trim(); if k.is_empty() { return Err(err("请输入授权码")); }
    let dr = s.app.data_root.clone(); let r = crate::license::verify_license(k, &dr);
    if r.valid {
        let p = license_path(&dr);
        if let Some(par) = p.parent() { let _ = std::fs::create_dir_all(par); }
        if let Err(e) = std::fs::write(&p, k) { log::warn!("lic save: {}", e); }
    }
    Ok(serde_json::to_value(&r).unwrap_or_default())
}
pub async fn license_deactivate(s: &ServerState) -> serde_json::Value {
    let dr = s.app.data_root.clone();
    let _ = std::fs::remove_file(license_path(&dr));
    serde_json::json!({"activated":false,"machineCode":crate::license::get_machine_code()})
}

// 9. System ops
pub async fn open_folder(path: String) -> serde_json::Value {
    #[cfg(target_os="windows")]
    { std::process::Command::new("explorer").arg(&path).creation_flags(0x08000000).spawn().ok(); }
    #[cfg(target_os="macos")]
    { std::process::Command::new("open").arg(&path).spawn().ok(); }
    serde_json::json!({"ok":true})
}
pub async fn open_url(url: String) -> Result<serde_json::Value, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") { return Err(err("Only http/https URLs are supported")); }
    #[cfg(target_os="windows")]
    {
        // 用 rundll32 url.dll,FileProtocolHandler 打开 URL，
        // 避免 cmd /c start 把 URL 中的 & 当作命令分隔符导致参数丢失
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(0x08000000)
            .spawn()
            .ok();
    }
    #[cfg(target_os="macos")]
    { std::process::Command::new("open").arg(&url).spawn().ok(); }
    Ok(serde_json::json!({"ok":true}))
}
pub async fn browse_folder() -> serde_json::Value {
    #[cfg(target_os="windows")] {
        let script = "Add-Type -AssemblyName System.Windows.Forms
$fb = New-Object System.Windows.Forms.FolderBrowserDialog
$fb.Description = \"Select workspace folder\"
if ($fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $fb.SelectedPath }";
        let o = std::process::Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-Command",script]).creation_flags(0x08000000).output();
        match o {
            Ok(x) if x.status.success() => {
                let p = String::from_utf8_lossy(&x.stdout).trim().to_string();
                if !p.is_empty() { serde_json::json!({"path":p}) } else { serde_json::json!({"path":serde_json::Value::Null}) }
            }
            _ => serde_json::json!({"path":serde_json::Value::Null}),
        }
    }
    #[cfg(not(target_os="windows"))] { serde_json::json!({"path":serde_json::Value::Null}) }
}

// axum adapters
pub fn to_response(r: Result<serde_json::Value, String>) -> axum::response::Response {
    use axum::{http::StatusCode, Json, response::IntoResponse};
    match r {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(m) => (StatusCode::BAD_REQUEST, Json(ApiResponse::<()>{ ok:false, data:None, error:Some(m) })).into_response(),
    }
}
pub fn to_response_err(r: Result<serde_json::Value, String>, s: axum::http::StatusCode) -> axum::response::Response {
    use axum::{http::StatusCode, Json, response::IntoResponse};
    match r {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(m) => (s, Json(ApiResponse::<()>{ ok:false, data:None, error:Some(m) })).into_response(),
    }
}
pub fn ok_response(v: serde_json::Value) -> axum::response::Response {
    use axum::{http::StatusCode, Json, response::IntoResponse};
    (StatusCode::OK, Json(v)).into_response()
}
