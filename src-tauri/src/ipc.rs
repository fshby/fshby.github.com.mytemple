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
pub async fn knowledge_health(s: &ServerState) -> serde_json::Value { s.app.health_check().await }
pub async fn get_version(refresh: &str) -> serde_json::Value {
    use super::handlers::fetch_remote_version_pub;
    if bool_flag(refresh) { if let Ok(r) = fetch_remote_version_pub().await { return r; } }
    let m = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let vp = m.parent().unwrap_or(m).join("version.json");
    match std::fs::read_to_string(&vp) {
        Ok(c) => serde_json::from_str::<serde_json::Value>(&c).unwrap_or_else(|_| serde_json::json!({ "raw": c })),
        Err(_) => serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "name": "MyTemple Knowledge" }),
    }
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
pub async fn search(s: &ServerState, q: String) -> serde_json::Value {
    serde_json::json!({"results": s.app.search(&q).await})
}
pub async fn get_graph(s: &ServerState) -> serde_json::Value {
    let f = s.app.get_files().await;
    // FileEntry.content 采用懒加载（scan_workspace 时为 None），图谱构建需要真实正文
    // 解析 [[wikilink]] 产生 link 边；否则所有 doc 节点都会因为无边且默认
    // showOrphans=false 被前端过滤，导致图谱界面没有任何文档节点显示。
    // 对 content 为 None 的文件触发 read_file_force 磁盘读取并回填缓存，
    // 失败则用空字符串兜底（不影响其他文件的图谱构建）。
    let gf: Vec<crate::utils::GraphFile> = {
        let mut out: Vec<crate::utils::GraphFile> = Vec::with_capacity(f.len());
        for x in f.iter() {
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
                path: x.path.clone(), relative: x.path.clone(), title: x.title.clone(),
                content, tags: s.app.token_dict.lookup_many(&x.tags),
                terms,
                workspace_id: x.workspace_id.clone(), workspace_name: Some(x.workspace_name.clone()), modified: x.modified,
            });
        }
        out
    };
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
    { std::process::Command::new("cmd").args(["/c", "start", "", &url]).creation_flags(0x08000000).spawn().ok(); }
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
