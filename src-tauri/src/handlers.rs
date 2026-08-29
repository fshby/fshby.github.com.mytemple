// handlers.rs - Native API handlers for MyTemple
//
// Phase 2 native handlers: workspace management, file CRUD, search, graph,
// file operations (move/copy/rename), frontmatter, health check, system ops.
// Unimplemented endpoints are handled by the sidecar proxy in server.rs.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::os::windows::process::CommandExt;
use crate::server::ServerState;

// ── 通用响应封装 ──────────────────────────────────────────

#[derive(Serialize)]
struct ApiResponse<T: Serialize> {
    ok: bool,
    data: Option<T>,
    error: Option<String>,
}

impl<T: Serialize> ApiResponse<T> {
    fn success(data: T) -> Self {
        Self { ok: true, data: Some(data), error: None }
    }
    fn error(msg: impl Into<String>) -> Self {
        Self { ok: false, data: None, error: Some(msg.into()) }
    }
}

fn json_ok<T: Serialize>(data: T) -> Response {
    (StatusCode::OK, Json(ApiResponse::success(data))).into_response()
}

fn json_err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(ApiResponse::<()>::error(msg))).into_response()
}

fn raw_json<T: Serialize>(data: T) -> Response {
    (StatusCode::OK, Json(data)).into_response()
}

// ── 路由构建 ──────────────────────────────────────────────

pub fn build_native_router(state: Arc<ServerState>) -> Router {
    Router::new()
        // 健康检查
        .route("/api/health", get(health))
        .route("/api/knowledge/health", get(knowledge_health))
        // 版本信息
        .route("/api/version", get(get_version))
        // 系统路径
        .route("/api/system-paths", get(get_system_paths))
        // 工作区
        .route("/api/workspaces", get(get_workspaces))
        .route("/api/workspaces/add", post(add_workspace))
        .route("/api/workspaces/remove", post(remove_workspace))
        .route("/api/workspaces/rename", post(rename_workspace))
        .route("/api/workspaces/set-default", post(set_default_workspace))
        .route("/api/workspaces/show", post(show_workspace))
        .route("/api/workspaces/set-md-only", post(set_md_only))
        // 文件树
        .route("/api/tree", get(get_tree))
        // 文件 CRUD
        .route("/api/files", get(list_files))
        .route("/api/files/*path", get(read_file))
        .route("/api/files", post(save_file))
        .route("/api/files/*path", delete(delete_file))
        // 文档
        .route("/api/doc", get(get_doc))
        .route("/api/save", post(save_doc))
        .route("/api/delete", post(delete_docs))
        .route("/api/create-folder", post(create_folder))
        .route("/api/create-doc", post(create_document))
        // 搜索
        .route("/api/search", get(search))
        // 知识图谱
        .route("/api/graph", get(get_graph))
        // 缓存刷新
        .route("/api/refresh-cache", post(refresh_cache))
        // 文件操作
        .route("/api/move", post(move_entry))
        .route("/api/copy", post(copy_entry))
        .route("/api/rename", post(rename_entry))
        // Frontmatter
        .route("/api/frontmatter", get(get_frontmatter))
        .route("/api/frontmatter/preview", post(preview_frontmatter))
        .route("/api/frontmatter/apply", post(apply_frontmatter))
        // 系统操作
        .route("/api/open-folder", post(open_folder))
        .route("/api/open-url", post(open_url))
        .route("/api/browse-folder", post(browse_folder))
        // AI 智能功能
        .route("/api/ai/status", get(ai_status))
        .route("/api/ai/test", post(ai_test))
        .route("/api/ai/config", post(ai_config))
        .route("/api/ai/reindex", post(ai_reindex))
        .route("/api/ai/query", post(ai_query))
        .route("/api/ai/transform", post(ai_transform))
        // 资源管理
        .route("/api/asset", post(upload_asset))
        .route("/api/asset/delete", post(delete_asset))
        // 资源文件服务
        .route("/source/*path", get(serve_source))
        .route("/ws-asset/:ws_id/*relative", get(serve_ws_asset))
        // Import/Export
        .route("/api/import", post(import_document))
        .route("/api/export", post(export_document))
        // 语义标签
        .route("/api/semantic-tags", post(semantic_tags))
        // Markdown 规范化
        .route("/api/normalize-md", post(normalize_md))
        // Agent 策略
        .route("/api/agent/policy", get(get_agent_policy))
        .route("/api/agent/policy/create", post(create_agent_policy))
        // 更新检查
        .route("/api/update/check", post(check_update))
        // 视频上传
        .route("/api/upload-video", post(upload_video))
        // 工作区粘贴
        .route("/api/workspaces/paste", post(paste_workspace))
        // 目录浏览
        .route("/api/browse-directory", get(browse_directory_roots))
        .route("/api/browse-directory", post(browse_directory))
        // Agent 操作
        .route("/api/agent/action/preview", post(agent_action_preview))
        .route("/api/agent/action/apply", post(agent_action_apply))
        // 授权管理
        .route("/api/license/status", get(license_status))
        .route("/api/license/check", get(license_check))
        .route("/api/license/activate", post(license_activate))
        .route("/api/license/deactivate", post(license_deactivate))
        .with_state(state)
}

// ── Handler 实现 ──────────────────────────────────────────

/// GET /api/health
async fn health() -> impl IntoResponse {
    raw_json(serde_json::json!({ "status": "ok" }))
}

/// GET /api/knowledge/health
async fn knowledge_health(
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    let health = state.app.health_check().await;
    raw_json(health)
}

/// GET /api/version
/// ?refresh=1 → 强制从远程服务器拉取最新版本信息（用于升级检查）
/// 默认 → 读本地 version.json（不存在则 fallback 到 CARGO_PKG_VERSION），启动加载很快
#[derive(Deserialize)]
struct VersionQuery {
    #[serde(default)]
    refresh: String,
}

async fn get_version(query: Query<VersionQuery>) -> impl IntoResponse {
    let should_refresh = query.refresh == "1" || query.refresh.eq_ignore_ascii_case("true");

    if should_refresh {
        // 优先 fetch 远程
        match fetch_remote_version().await {
            Ok(remote) => return raw_json(remote),
            Err(e) => {
                eprintln!("[get_version] 远程失败，降级本地: {}", e);
            }
        }
    }

    // 本地 fallback
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let version_path = manifest_dir.parent().unwrap_or(manifest_dir).join("version.json");
    match std::fs::read_to_string(&version_path) {
        Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(value) => raw_json(value),
            Err(_) => raw_json(serde_json::json!({ "raw": content })),
        },
        Err(_) => raw_json(serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "name": "MyTemple Knowledge"
        })),
    }
}

// ── 远程版本拉取 + 版本比较 ──────────────────────────────────

const REMOTE_VERSION_URL: &str = "https://mytemple.fshby.cc/version.json";

/// 拉取远程 version.json
async fn fetch_remote_version() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    let resp = client
        .get(REMOTE_VERSION_URL)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    let text = resp.text().await.map_err(|e| format!("读取失败: {}", e))?;
    serde_json::from_str(&text).map_err(|e| format!("解析失败: {}", e))
}

/// 比较 a 和 b 两个语义化版本字符串（如 "1.8.93"）
/// 返回 Ordering::Greater 表示 a > b
fn cmp_versions(a: &str, b: &str) -> std::cmp::Ordering {
    fn parse(v: &str) -> Vec<u64> {
        v.split('.')
            .map(|s| s.parse::<u64>().unwrap_or(0))
            .collect()
    }
    let mut pa = parse(a);
    let mut pb = parse(b);
    let n = pa.len().max(pb.len());
    pa.resize(n, 0);
    pb.resize(n, 0);
    pa.cmp(&pb)
}

/// GET /api/system-paths
async fn get_system_paths() -> impl IntoResponse {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let local_appdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
    raw_json(serde_json::json!({
        "home": home,
        "appdata": appdata,
        "localAppData": local_appdata,
    }))
}

// ── 工作区 ───────────────────────────────────────────────

/// GET /api/workspaces
async fn get_workspaces(
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    let workspaces = state.app.get_workspaces().await;
    let default_id = state.app.get_default_workspace_id().await;
    let visible: Vec<crate::app::Workspace> = workspaces
        .iter()
        .filter(|w| w.visible)
        .take(2)
        .cloned()
        .collect();
    let mut recent = workspaces.clone();
    recent.sort_by(|a, b| b.last_used.cmp(&a.last_used));
    recent.truncate(8);
    raw_json(serde_json::json!({
        "workspaces": workspaces,
        "defaultWorkspaceId": default_id,
        "visible": visible,
        "recent": recent,
    }))
}

#[derive(Deserialize)]
struct AddWorkspaceRequest {
    path: String,
    name: Option<String>,
}

async fn add_workspace(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<AddWorkspaceRequest>,
) -> impl IntoResponse {
    let name = req.name.unwrap_or_default();
    match state.app.add_workspace(&req.path, &name).await {
        Ok(ws) => json_ok(ws),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct RemoveWorkspaceRequest {
    id: String,
}

async fn remove_workspace(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<RemoveWorkspaceRequest>,
) -> impl IntoResponse {
    match state.app.remove_workspace(&req.id).await {
        Ok(()) => raw_json(serde_json::json!({ "ok": true })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct RenameWorkspaceRequest {
    id: String,
    name: String,
}

async fn rename_workspace(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<RenameWorkspaceRequest>,
) -> impl IntoResponse {
    match state.app.rename_workspace(&req.id, &req.name).await {
        Ok(()) => raw_json(serde_json::json!({ "ok": true })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct SetDefaultRequest {
    id: String,
}

async fn set_default_workspace(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<SetDefaultRequest>,
) -> impl IntoResponse {
    match state.app.set_default_workspace(&req.id).await {
        Ok(()) => raw_json(serde_json::json!({ "ok": true })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct ShowWorkspaceRequest {
    id: String,
    visible: Option<bool>,
}

async fn show_workspace(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<ShowWorkspaceRequest>,
) -> impl IntoResponse {
    let visible = req.visible.unwrap_or(true);
    match state.app.show_workspace(&req.id, visible).await {
        Ok(()) => raw_json(serde_json::json!({ "ok": true })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct SetMdOnlyRequest {
    id: String,
    #[serde(rename = "mdOnly")]
    md_only: Option<bool>,
}

async fn set_md_only(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<SetMdOnlyRequest>,
) -> impl IntoResponse {
    let md_only = req.md_only.unwrap_or(false);
    match state.app.set_md_only(&req.id, md_only).await {
        Ok(()) => raw_json(serde_json::json!({ "ok": true })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

// ── 文件树 ───────────────────────────────────────────────

async fn get_tree(
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    let tree = state.app.get_tree().await;
    let workspace_nodes = tree.children;
    let files = state.app.get_files().await;
    let workspaces = state.app.get_workspaces().await;
    let default_id = state.app.get_default_workspace_id().await;
    raw_json(serde_json::json!({
        "tree": workspace_nodes,
        "count": files.len(),
        "workspaces": workspaces,
        "defaultWorkspaceId": default_id,
    }))
}

// ── 文件 CRUD ────────────────────────────────────────────

async fn list_files(
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    let files = state.app.get_files().await;
    json_ok(files)
}

async fn read_file(
    State(state): State<Arc<ServerState>>,
    Path(path): Path<String>,
) -> impl IntoResponse {
    match state.app.read_file(&path).await {
        Ok(entry) => json_ok(entry),
        Err(e) => json_err(StatusCode::NOT_FOUND, e.to_string()),
    }
}

#[derive(Deserialize)]
struct SaveFileRequest {
    path: String,
    content: String,
}

async fn save_file(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<SaveFileRequest>,
) -> impl IntoResponse {
    match state.app.save_file(&req.path, &req.content).await {
        Ok(hash) => json_ok(serde_json::json!({ "sha256": hash })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

async fn delete_file(
    State(state): State<Arc<ServerState>>,
    Path(path): Path<String>,
) -> impl IntoResponse {
    match state.app.delete_file(&path).await {
        Ok(()) => json_ok(serde_json::json!({})),
        Err(e) => json_err(StatusCode::NOT_FOUND, e.to_string()),
    }
}

// ── 文档 API ─────────────────────────────────────────────

#[derive(Deserialize)]
struct DocQuery {
    path: String,
}

async fn get_doc(
    State(state): State<Arc<ServerState>>,
    Query(params): Query<DocQuery>,
) -> impl IntoResponse {
    match state.app.read_file(&params.path).await {
        Ok(entry) => raw_json(serde_json::json!({
            "path": entry.path,
            "title": entry.title,
            "content": entry.content,
            "tags": entry.tags,
            "terms": entry.terms,
            "encoding": entry.encoding,
            "contentSha256": entry.content_sha256,
            "created": entry.created,
            "modified": entry.modified,
        })),
        Err(e) => json_err(StatusCode::NOT_FOUND, e.to_string()),
    }
}

#[derive(Deserialize)]
struct SaveDocRequest {
    path: String,
    content: String,
}

async fn save_doc(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<SaveDocRequest>,
) -> impl IntoResponse {
    match state.app.save_file(&req.path, &req.content).await {
        Ok(hash) => raw_json(serde_json::json!({
            "ok": true,
            "path": req.path,
            "contentSha256": hash,
        })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct DeleteDocRequest {
    path: serde_json::Value,
}

async fn delete_docs(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<DeleteDocRequest>,
) -> impl IntoResponse {
    let paths: Vec<String> = match req.path {
        serde_json::Value::String(s) => vec![s],
        serde_json::Value::Array(arr) => arr.into_iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        _ => return json_err(StatusCode::BAD_REQUEST, "path must be a string or array of strings"),
    };
    let mut errors = Vec::new();
    for path in &paths {
        if let Err(e) = state.app.delete_file(path).await {
            errors.push(format!("{}: {}", path, e));
        }
    }
    if errors.is_empty() {
        raw_json(serde_json::json!({ "ok": true }))
    } else {
        json_err(StatusCode::PARTIAL_CONTENT, errors.join("; "))
    }
}

#[derive(Deserialize)]
struct CreateFolderRequest {
    parent: String,
    name: String,
}

async fn create_folder(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<CreateFolderRequest>,
) -> impl IntoResponse {
    match state.app.create_folder(&req.parent, &req.name).await {
        Ok(path) => raw_json(serde_json::json!({ "ok": true, "path": path })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct CreateDocRequest {
    parent: String,
    name: String,
}

async fn create_document(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<CreateDocRequest>,
) -> impl IntoResponse {
    match state.app.create_doc(&req.parent, &req.name).await {
        Ok((path, hash)) => raw_json(serde_json::json!({
            "ok": true,
            "path": path,
            "contentSha256": hash,
        })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

// ── 搜索 ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn search(
    State(state): State<Arc<ServerState>>,
    Query(params): Query<SearchQuery>,
) -> impl IntoResponse {
    let results = state.app.search(&params.q).await;
    raw_json(serde_json::json!({ "results": results }))
}

// ── 知识图谱 ─────────────────────────────────────────────

async fn get_graph(
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    let files = state.app.get_files().await;
    let graph_files: Vec<crate::utils::GraphFile> = files
        .iter()
        .map(|f| crate::utils::GraphFile {
            path: f.path.clone(),
            relative: f.path.clone(),
            title: f.title.clone(),
            content: f.content.clone(),
            tags: f.tags.clone(),
            terms: f
                .terms
                .iter()
                .map(|t| crate::utils::TermCount {
                    term: t.clone(),
                    count: 1,
                })
                .collect(),
            workspace_id: f.workspace_id.clone(),
            workspace_name: Some(f.workspace_name.clone()),
            modified: f.modified,
        })
        .collect();
    let graph = crate::utils::build_graph(&graph_files);
    raw_json(graph)
}

// ── 缓存刷新 ─────────────────────────────────────────────

async fn refresh_cache(
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    match state.app.refresh_cache().await {
        Ok(()) => raw_json(serde_json::json!({ "ok": true })),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// ── 文件操作 ─────────────────────────────────────────────

#[derive(Deserialize)]
struct MoveRequest {
    source: String,
    #[serde(rename = "targetFolder")]
    target_folder: String,
}

async fn move_entry(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<MoveRequest>,
) -> impl IntoResponse {
    match state.app.move_entry(&req.source, &req.target_folder).await {
        Ok((path, is_dir)) => raw_json(serde_json::json!({
            "ok": true,
            "from": req.source,
            "path": path,
            "type": if is_dir { "folder" } else { "file" },
        })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct CopyRequest {
    source: String,
    #[serde(rename = "targetFolder")]
    target_folder: String,
}

async fn copy_entry(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<CopyRequest>,
) -> impl IntoResponse {
    match state.app.copy_entry(&req.source, &req.target_folder).await {
        Ok(path) => raw_json(serde_json::json!({ "ok": true, "path": path })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct RenameRequest {
    path: String,
    #[serde(rename = "newName")]
    new_name: String,
}

async fn rename_entry(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<RenameRequest>,
) -> impl IntoResponse {
    match state.app.rename_entry(&req.path, &req.new_name).await {
        Ok(new_path) => raw_json(serde_json::json!({ "ok": true, "newPath": new_path })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

// ── Frontmatter ──────────────────────────────────────────

#[derive(Deserialize)]
struct FrontmatterQuery {
    path: String,
}

async fn get_frontmatter(
    State(state): State<Arc<ServerState>>,
    Query(params): Query<FrontmatterQuery>,
) -> impl IntoResponse {
    match state.app.get_frontmatter(&params.path).await {
        Ok(data) => raw_json(data),
        Err(e) => json_err(StatusCode::NOT_FOUND, e.to_string()),
    }
}

#[derive(Deserialize)]
struct FrontmatterPreviewRequest {
    path: String,
    metadata: Option<serde_json::Value>,
}

async fn preview_frontmatter(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<FrontmatterPreviewRequest>,
) -> impl IntoResponse {
    let metadata = req.metadata.unwrap_or_else(|| serde_json::json!({}));
    match state.app.preview_frontmatter(&req.path, &metadata).await {
        Ok(data) => raw_json(data),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct FrontmatterApplyRequest {
    path: String,
    metadata: Option<serde_json::Value>,
    #[serde(rename = "baseHash")]
    base_hash: String,
    confirmed: Option<bool>,
}

async fn apply_frontmatter(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<FrontmatterApplyRequest>,
) -> impl IntoResponse {
    if req.confirmed != Some(true) {
        return json_err(StatusCode::BAD_REQUEST, "Confirmation required");
    }
    let metadata = req.metadata.unwrap_or_else(|| serde_json::json!({}));
    match state.app.apply_frontmatter(&req.path, &metadata, &req.base_hash).await {
        Ok(data) => raw_json(data),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

// ── 系统操作 ─────────────────────────────────────────────

#[derive(Deserialize)]
struct OpenFolderRequest {
    path: String,
}

async fn open_folder(
    Json(req): Json<OpenFolderRequest>,
) -> impl IntoResponse {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&req.path)
            .creation_flags(0x08000000)
            .spawn()
            .ok();
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&req.path).spawn().ok();
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = &req.path;
    }
    raw_json(serde_json::json!({ "ok": true }))
}

#[derive(Deserialize)]
struct OpenUrlRequest {
    url: String,
}

async fn open_url(
    Json(req): Json<OpenUrlRequest>,
) -> impl IntoResponse {
    let url = &req.url;
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return json_err(StatusCode::BAD_REQUEST, "Only http/https URLs are supported");
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", url])
            .creation_flags(0x08000000)
            .spawn()
            .ok();
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn().ok();
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = url;
    }
    raw_json(serde_json::json!({ "ok": true }))
}

async fn browse_folder() -> impl IntoResponse {
    #[cfg(target_os = "windows")]
    {
        let script = r#"Add-Type -AssemblyName System.Windows.Forms
$fb = New-Object System.Windows.Forms.FolderBrowserDialog
$fb.Description = "Select workspace folder"
if ($fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $fb.SelectedPath
}"#;
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(0x08000000)
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !path.is_empty() {
                    raw_json(serde_json::json!({ "path": path }))
                } else {
                    raw_json(serde_json::json!({ "path": serde_json::Value::Null }))
                }
            }
            _ => raw_json(serde_json::json!({ "path": serde_json::Value::Null })),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        raw_json(serde_json::json!({ "path": serde_json::Value::Null }))
    }
}

// ── AI 智能功能 ──────────────────────────────────────────

/// GET /api/ai/status
async fn ai_status(
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    let rag = &state.rag;
    // Try to load if not loaded
    let _ = rag.load();
    raw_json(rag.status())
}

/// POST /api/ai/test — 真实连接测试
/// 接受完整 config payload（与 /api/ai/config 相同），实测 Ollama /api/tags、/api/embed
/// 以及 DeepSeek chat，返回前端期望的结构化结果。
#[derive(Deserialize)]
#[serde(default)]
struct AiTestRequest {
    #[serde(rename = "baseUrl")]
    base_url: String,
    #[serde(rename = "embeddingModel")]
    embedding_model: String,
    #[serde(rename = "chatModel")]
    chat_model: String,
    #[serde(rename = "chatProvider")]
    chat_provider: String,
    #[serde(rename = "deepseekApiKey")]
    deepseek_api_key: String,
    #[serde(rename = "deepseekBaseUrl")]
    deepseek_base_url: String,
    #[serde(rename = "deepseekChatModel")]
    deepseek_chat_model: String,
}

impl Default for AiTestRequest {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            embedding_model: String::new(),
            chat_model: String::new(),
            chat_provider: "ollama".to_string(),
            deepseek_api_key: String::new(),
            deepseek_base_url: "https://api.deepseek.com".to_string(),
            deepseek_chat_model: "deepseek-chat".to_string(),
        }
    }
}

async fn ai_test(
    State(_state): State<Arc<ServerState>>,
    Json(req): Json<AiTestRequest>,
) -> impl IntoResponse {
    let provider = req.chat_provider.trim().to_lowercase();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build();
    let client = match client {
        Ok(c) => c,
        Err(e) => {
            return raw_json(serde_json::json!({
                "ok": false,
                "error": format!("HTTP 客户端创建失败: {}", e),
            }));
        }
    };

    let mut models: Vec<serde_json::Value> = Vec::new();
    let mut recommended_embedding: Option<String> = None;
    let mut embedding_check = serde_json::json!({ "ok": true });
    let mut chat_check = serde_json::json!({ "ok": true });
    let mut compat_embedding = serde_json::json!({});
    let mut compat_chat = serde_json::json!({});

    // ── Ollama 测试 ──
    if provider == "ollama" {
        let base = req.base_url.trim().trim_end_matches('/').to_string();
        if base.is_empty() {
            embedding_check = serde_json::json!({
                "ok": false,
                "error": "未配置 Ollama 服务地址（baseUrl）"
            });
            chat_check = serde_json::json!({
                "ok": false,
                "error": "未配置 Ollama 服务地址（baseUrl）"
            });
        } else {
            // 1) 列出 Ollama 所有模型
            let tags_url = format!("{}/api/tags", base);
            match client.get(&tags_url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        if let Some(arr) = json.get("models").and_then(|v| v.as_array()) {
                            for m in arr {
                                let name = m.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                if !name.is_empty() {
                                    models.push(serde_json::json!({ "name": name }));
                                }
                            }
                        }
                    }
                }
                Ok(resp) => {
                    let code = resp.status().as_u16();
                    let err = resp.text().await.unwrap_or_default();
                    embedding_check = serde_json::json!({
                        "ok": false,
                        "error": format!("Ollama /api/tags HTTP {}: {}", code, err)
                    });
                    chat_check = embedding_check.clone();
                }
                Err(e) => {
                    let msg = format!("无法连接 Ollama ({}): {}", base, e);
                    embedding_check = serde_json::json!({ "ok": false, "error": msg });
                    chat_check = embedding_check.clone();
                }
            }

            // 2) 推荐 embedding 模型：优先选不含 chat 关键字的
            let emb_model_names: Vec<String> = models
                .iter()
                .filter_map(|m| m.get("name").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .collect();
            let current_emb = req.embedding_model.trim();
            if !emb_model_names.is_empty() {
                // 如果当前配置的模型在列表中，推荐它
                if !current_emb.is_empty() && emb_model_names.iter().any(|n| n == current_emb) {
                    recommended_embedding = Some(current_emb.to_string());
                } else {
                    // 找第一个看起来像 embedding 的（不含 chat、llama、gemma、qwen2.5 等）
                    let emb_like = emb_model_names.iter().find(|n| {
                        let lower = n.to_lowercase();
                        lower.contains("embed")
                            || lower.contains("bge")
                            || lower.contains("e5-")
                            || lower.contains("jina")
                            || lower.contains("minilm")
                    });
                    if let Some(n) = emb_like {
                        recommended_embedding = Some(n.clone());
                    } else {
                        // 兜底：排除聊天类模型后的第一个
                        let chat_keywords = ["chat", "llama", "gemma", "qwen2", "mistral", "mixtral", "phi"];
                        let fallback = emb_model_names.iter().find(|n| {
                            let lower = n.to_lowercase();
                            !chat_keywords.iter().any(|kw| lower.contains(kw))
                        });
                        if let Some(n) = fallback {
                            recommended_embedding = Some(n.clone());
                        } else {
                            recommended_embedding = Some(emb_model_names[0].clone());
                        }
                    }
                }
            }

            // 3) 实测 embedding
            if !req.embedding_model.trim().is_empty() {
                let embed_url = format!("{}/api/embed", base);
                let body = serde_json::json!({
                    "model": req.embedding_model.trim(),
                    "input": "test"
                });
                match client.post(&embed_url).json(&body).send().await {
                    Ok(resp) if resp.status().is_success() => {
                        if let Ok(json) = resp.json::<serde_json::Value>().await {
                            let dim = json
                                .get("embedding")
                                .and_then(|v| v.as_array())
                                .map(|a| a.len())
                                .or_else(|| {
                                    json.get("embeddings")
                                        .and_then(|v| v.as_array())
                                        .and_then(|arr| arr.first())
                                        .and_then(|v| v.as_array())
                                        .map(|a| a.len())
                                });
                            if let Some(d) = dim {
                                embedding_check = serde_json::json!({ "ok": true, "dimension": d });
                            } else {
                                embedding_check = serde_json::json!({
                                    "ok": false,
                                    "error": "Ollama /api/embed 返回缺少 embedding 字段"
                                });
                            }
                        } else {
                            embedding_check = serde_json::json!({
                                "ok": false,
                                "error": "Ollama /api/embed 返回非 JSON"
                            });
                        }
                    }
                    Ok(resp) => {
                        let code = resp.status().as_u16();
                        let err = resp.text().await.unwrap_or_default();
                        embedding_check = serde_json::json!({
                            "ok": false,
                            "error": format!("Embedding 模型测试失败 HTTP {}: {}", code, err)
                        });
                    }
                    Err(e) => {
                        embedding_check = serde_json::json!({
                            "ok": false,
                            "error": format!("Embedding 请求失败: {}", e)
                        });
                    }
                }
            }

            // 4) 实测 chat
            if !req.chat_model.trim().is_empty() {
                let chat_url = format!("{}/api/chat", base);
                let body = serde_json::json!({
                    "model": req.chat_model.trim(),
                    "messages": [{ "role": "user", "content": "hi" }],
                    "stream": false
                });
                match client.post(&chat_url).json(&body).send().await {
                    Ok(resp) if resp.status().is_success() => {
                        chat_check = serde_json::json!({ "ok": true });
                    }
                    Ok(resp) => {
                        let code = resp.status().as_u16();
                        let err = resp.text().await.unwrap_or_default();
                        chat_check = serde_json::json!({
                            "ok": false,
                            "error": format!("Chat 模型测试失败 HTTP {}: {}", code, err)
                        });
                    }
                    Err(e) => {
                        chat_check = serde_json::json!({
                            "ok": false,
                            "error": format!("Chat 请求失败: {}", e)
                        });
                    }
                }
            }
        }
    }

    // ── DeepSeek 测试 ──
    if provider == "deepseek" {
        // embedding 跳过（DeepSeek 无向量模型）
        embedding_check = serde_json::json!({
            "ok": true,
            "note": "DeepSeek 不提供向量模型，语义索引仍使用本地 Ollama 向量模型"
        });

        let api_key = req.deepseek_api_key.trim();
        if api_key.is_empty() {
            chat_check = serde_json::json!({
                "ok": false,
                "error": "未配置 DeepSeek API Key"
            });
        } else {
            let deepseek_base = req.deepseek_base_url.trim().trim_end_matches('/').to_string();
            let deepseek_chat = req.deepseek_chat_model.trim().to_string();
            let chat_url = format!("{}/chat/completions", deepseek_base);
            let body = serde_json::json!({
                "model": if deepseek_chat.is_empty() { "deepseek-chat" } else { deepseek_chat.as_str() },
                "messages": [{ "role": "user", "content": "hi" }],
                "max_tokens": 5
            });
            match client
                .post(&chat_url)
                .header("Authorization", format!("Bearer {}", api_key))
                .json(&body)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    chat_check = serde_json::json!({ "ok": true });
                }
                Ok(resp) => {
                    let code = resp.status().as_u16();
                    let err = resp.text().await.unwrap_or_default();
                    chat_check = serde_json::json!({
                        "ok": false,
                        "error": format!("DeepSeek API HTTP {}: {}", code, err)
                    });
                }
                Err(e) => {
                    chat_check = serde_json::json!({
                        "ok": false,
                        "error": format!("DeepSeek 连接失败: {}", e)
                    });
                }
            }
        }
    }

    raw_json(serde_json::json!({
        "ok": true,
        "models": models,
        "recommendedEmbeddingModel": recommended_embedding,
        "embeddingCheck": embedding_check,
        "chatCheck": chat_check,
        "compatibility": serde_json::json!({
            "embedding": compat_embedding,
            "chat": compat_chat
        })
    }))
}

/// POST /api/ai/config
#[derive(Deserialize)]
struct AiConfigRequest {
    enabled: Option<bool>,
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
    #[serde(rename = "embeddingModel")]
    embedding_model: Option<String>,
    #[serde(rename = "chatModel")]
    chat_model: Option<String>,
    #[serde(rename = "chatProvider")]
    chat_provider: Option<String>,
    #[serde(rename = "deepseekApiKey")]
    deepseek_api_key: Option<String>,
    #[serde(rename = "deepseekBaseUrl")]
    deepseek_base_url: Option<String>,
    #[serde(rename = "deepseekChatModel")]
    deepseek_chat_model: Option<String>,
    #[serde(rename = "maxSources")]
    max_sources: Option<u32>,
    #[serde(rename = "retrievalMode")]
    retrieval_mode: Option<String>,
}

async fn ai_config(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<AiConfigRequest>,
) -> impl IntoResponse {
    let rag = &state.rag;
    let _ = rag.load();

    {
        let mut settings = rag.settings.lock().unwrap();
        if let Some(v) = req.enabled { settings.enabled = v; }
        if let Some(v) = req.base_url { settings.base_url = v; }
        if let Some(v) = req.embedding_model { settings.embedding_model = v; }
        if let Some(v) = req.chat_model { settings.chat_model = v; }
        if let Some(v) = req.chat_provider { settings.chat_provider = v; }
        if let Some(v) = req.deepseek_api_key { settings.deepseek_api_key = v; }
        if let Some(v) = req.deepseek_base_url { settings.deepseek_base_url = v; }
        if let Some(v) = req.deepseek_chat_model { settings.deepseek_chat_model = v; }
        if let Some(v) = req.max_sources { settings.max_sources = v; }
        if let Some(v) = req.retrieval_mode { settings.retrieval_mode = v; }
    }

    // Save settings
    let settings = rag.settings.lock().unwrap();
    let settings_json = serde_json::to_string_pretty(&*settings).unwrap_or_default();
    drop(settings);

    let settings_path = rag.root.join("..").join("ai-settings.json");
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let _ = std::fs::write(&settings_path, settings_json);

    raw_json(rag.public_settings())
}

/// POST /api/ai/reindex
async fn ai_reindex(
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    let rag = &state.rag;
    let _ = rag.load();

    let files = state.app.get_files().await;

    // Build index from files
    let mut all_chunks: Vec<crate::rag::Chunk> = Vec::new();
    let mut manifest_docs = std::collections::HashMap::new();

    for file in &files {
        let indexed = crate::rag::IndexedFile {
            path: file.path.clone(),
            title: file.title.clone(),
            content: file.content.clone(),
            content_sha256: file.content_sha256.clone(),
            workspace_id: file.workspace_id.clone(),
        };
        let chunks = crate::rag::chunk_markdown(&indexed);
        let doc_sig = file.content_sha256.clone();
        let chunk_ids: Vec<String> = chunks.iter().map(|c| c.id.clone()).collect();
        manifest_docs.insert(file.path.clone(), crate::rag::DocManifest {
            signature: doc_sig,
            chunk_ids,
        });
        all_chunks.extend(chunks);
    }

    // Update state
    {
        let mut chunks_ref = rag.chunks.lock().unwrap();
        *chunks_ref = all_chunks.clone();
    }

    // Build manifest
    let manifest = crate::rag::Manifest {
        schema_version: crate::rag::SCHEMA_VERSION,
        knowledge_version: format!("k{}", Utc::now().timestamp_millis()),
        embedding_model: String::new(),
        requested_embedding_model: String::new(),
        dimension: 0,
        chunk_count: all_chunks.len(),
        vector_count: 0,
        indexed_at: Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        documents: manifest_docs,
    };

    {
        let mut m = rag.manifest.lock().unwrap();
        *m = manifest.clone();
    }

    // Save chunks
    let chunks_json: String = all_chunks.iter()
        .filter_map(|c| serde_json::to_string(c).ok())
        .collect::<Vec<_>>()
        .join("\n");
    let _ = std::fs::write(&rag.chunks_path, chunks_json);

    // Save manifest
    let _ = std::fs::write(&rag.manifest_path, serde_json::to_string_pretty(&manifest).unwrap_or_default());

    raw_json(serde_json::json!({
        "ok": true,
        "chunkCount": all_chunks.len(),
        "documentCount": manifest.documents.len(),
        "mode": "keyword",
        "note": "Vector indexing requires Ollama embedding model. Currently using keyword-only retrieval.",
    }))
}

/// POST /api/ai/query
#[derive(Deserialize)]
struct AiQueryRequest {
    question: String,
    scope: Option<String>,
    path: Option<String>,
    #[serde(rename = "maxSources")]
    max_sources: Option<u32>,
}

async fn ai_query(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<AiQueryRequest>,
) -> impl IntoResponse {
    let rag = &state.rag;
    let _ = rag.load();

    let scope = req.scope.unwrap_or_else(|| "all".to_string());
    let path = req.path.unwrap_or_default();
    let max_sources = req.max_sources.unwrap_or(6);

    let result = rag.retrieve(&req.question, &scope, &path, max_sources).await;

    // 拼接检索到的上下文，调用 AI 生成回答
    let context = result.sources.iter()
        .enumerate()
        .map(|(i, s)| format!("[{}] {}（{}）\n{}", i + 1, s.title, s.path, s.excerpt))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    let system_prompt = "你是一个知识库助手。根据以下检索到的文档片段回答用户问题。\
        如果文档片段中没有相关信息，请如实说明。回答时引用来源编号。";
    let user_prompt = format!("检索到的文档片段：\n\n{}\n\n用户问题：{}", context, req.question);

    let answer = match rag.chat(system_prompt, &user_prompt).await {
        Ok(text) => text,
        Err(e) => {
            // AI 调用失败时返回 sources 作为降级
            return raw_json(serde_json::json!({
                "ok": true,
                "answer": format!("（AI 生成失败：{}。以下为检索到的相关文档片段供参考）", e),
                "sources": result.sources,
                "retrievalMode": result.retrieval_mode,
                "question": req.question,
                "warning": e,
            }));
        }
    };

    raw_json(serde_json::json!({
        "ok": true,
        "answer": answer,
        "sources": result.sources,
        "retrievalMode": result.retrieval_mode,
        "question": req.question,
    }))
}

/// POST /api/ai/transform
#[derive(Deserialize)]
struct AiTransformRequest {
    text: String,
    #[serde(rename = "mode")]
    transform_mode: String,
    instruction: Option<String>,
    context: Option<String>,
}

async fn ai_transform(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<AiTransformRequest>,
) -> impl IntoResponse {
    let rag = &state.rag;

    // 构建系统提示词
    let mode_labels = match req.transform_mode.as_str() {
        "summary" => "摘要",
        "keypoints" => "要点",
        "terms" => "术语解释",
        "rewrite" => "改写",
        "code" => "代码补全",
        "comment" => "注释",
        "hint" => "提示",
        _ => "整理",
    };

    let system_prompt = format!(
        "你是一个文本处理助手。用户要求执行「{}」操作。请根据要求处理文本，直接输出结果，不要添加额外解释。",
        mode_labels
    );

    let instruction = req.instruction.unwrap_or_default();
    let context = req.context.unwrap_or_default();

    let mut user_prompt = String::new();
    if !instruction.is_empty() {
        user_prompt.push_str(&format!("用户要求：{}\n\n", instruction));
    }
    if !context.is_empty() {
        user_prompt.push_str(&format!("上下文：\n{}\n\n", context));
    }
    user_prompt.push_str(&format!("待处理文本：\n{}", req.text));

    match rag.chat(&system_prompt, &user_prompt).await {
        Ok(content) => raw_json(serde_json::json!({
            "ok": true,
            "content": content,
            "mode": req.transform_mode,
        })),
        Err(e) => {
            // AI 调用失败时降级为本地 fallback
            let fallback = crate::rag::fallback_transform_selection(&req.text, &req.transform_mode);
            match fallback {
                Ok(transformed) => raw_json(serde_json::json!({
                    "ok": true,
                    "content": transformed,
                    "mode": req.transform_mode,
                    "warning": format!("AI 调用失败，已使用本地处理: {}", e),
                })),
                Err(err) => json_err(StatusCode::BAD_REQUEST, err),
            }
        }
    }
}

// ── 资源管理 ──────────────────────────────────────────

#[derive(Deserialize)]
struct UploadAssetRequest {
    // New format (matches both editor paste and imageToMarkdown callers):
    #[serde(rename = "dataUrl")]
    data_url: Option<String>,
    name: Option<String>,
    #[serde(rename = "workspaceId")]
    workspace_id: Option<String>,

    // Legacy format (backwards-compat):
    path: Option<String>,
    #[serde(rename = "base64")]
    base64_data: Option<String>,
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
}

fn parse_data_url(data_url: &str) -> Result<(String, String), String> {
    // data:[<mime>][;base64],<payload>
    let trimmed = data_url.trim();
    if !trimmed.starts_with("data:") {
        return Err("not a data url".to_string());
    }
    let after_data = &trimmed[5..];
    let comma = after_data.find(',').ok_or_else(|| "missing data url comma".to_string())?;
    let meta = &after_data[..comma];
    let payload = &after_data[comma + 1..];

    let mut mime: Option<String> = None;
    let mut is_base64 = false;
    for part in meta.split(';') {
        if part == "base64" {
            is_base64 = true;
        } else if !part.is_empty() && mime.is_none() {
            mime = Some(part.to_string());
        }
    }
    if !is_base64 {
        return Err("data url is not base64 encoded".to_string());
    }
    Ok((
        mime.unwrap_or_else(|| "application/octet-stream".to_string()),
        payload.to_string(),
    ))
}

async fn upload_asset(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<UploadAssetRequest>,
) -> impl IntoResponse {
    use base64::Engine;

    // Normalize both old/new request formats into (bytes, preferred_name, mime)
    let (base64_raw, preferred_name, mime_from_req) = if let Some(data_url) = req.data_url.as_deref() {
        match parse_data_url(data_url) {
            Ok((m, payload)) => (payload, req.name.clone(), Some(m)),
            Err(e) => return json_err(StatusCode::BAD_REQUEST, format!("Invalid dataUrl: {}", e)),
        }
    } else if let (Some(b64), Some(path)) = (req.base64_data.as_deref(), req.path.as_deref()) {
        let p = std::path::Path::new(path);
        let name_from_path = p.file_name().and_then(|n| n.to_str()).map(|s| s.to_string());
        (b64.to_string(), name_from_path, req.mime_type.clone())
    } else {
        return json_err(StatusCode::BAD_REQUEST, "Missing fields: provide either {dataUrl} or {path, base64}".to_string());
    };

    let decoded = match base64::engine::general_purpose::STANDARD.decode(&base64_raw) {
        Ok(bytes) => bytes,
        Err(e) => return json_err(StatusCode::BAD_REQUEST, format!("Invalid base64: {}", e)),
    };

    // Resolve workspace root if workspaceId provided AND non-empty → save to <ws_root>/source/
    let ws_id_received = req.workspace_id.as_deref().filter(|id| !id.is_empty()).map(|s| s.to_string());
    let ws_root: Option<std::path::PathBuf> = if let Some(ws_id) = ws_id_received.as_deref() {
        let workspaces = state.app.get_workspaces().await;
        let found = workspaces.iter().find(|w| w.id == ws_id).map(|w| std::path::PathBuf::from(&w.root));
        log::info!("[upload_asset] workspaceId='{}', found_root={:?}, all_workspace_ids=[{}]",
            ws_id, found.as_ref().map(|p| p.to_string_lossy().to_string()),
            workspaces.iter().map(|w| w.id.as_str()).collect::<Vec<_>>().join(","));
        found
    } else {
        log::info!("[upload_asset] workspaceId empty or missing → using global data_root/assets");
        None
    };

    let file_name = preferred_name
        .clone()
        .or_else(|| req.path.clone())
        .unwrap_or_else(|| "asset".to_string());

    let p = std::path::Path::new(&file_name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("asset");
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("bin");

    let safe_stem: String = stem.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let safe_ext: String = ext.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>().to_lowercase();

    // Desired clean filename (without timestamp prefix)
    let desired_filename = format!("{}.{}", safe_stem, safe_ext);

    // Resolve actual asset directory — prefer workspace source/ if workspaceId valid
    let asset_dir: std::path::PathBuf;
    let display_filename: String;  // the one used in markdown URL
    if let Some(root) = ws_root {
        asset_dir = root.join("source");
        std::fs::create_dir_all(&asset_dir).ok();
        display_filename = desired_filename.clone();
    } else {
        asset_dir = state.app.data_root.join("assets");
        std::fs::create_dir_all(&asset_dir).ok();
        display_filename = desired_filename.clone();
    }

    // Avoid collisions: if file exists, append _1, _2...
    let mut final_filename = desired_filename.clone();
    let mut counter = 1u32;
    while asset_dir.join(&final_filename).exists() {
        final_filename = format!("{}_{}.{}", safe_stem, counter, safe_ext);
        counter += 1;
    }

    let asset_path = asset_dir.join(&final_filename);

    let final_mime = mime_from_req.unwrap_or_else(|| {
        match ext.to_lowercase().as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            _ => "application/octet-stream",
        }.to_string()
    });

    match std::fs::write(&asset_path, &decoded) {
        Ok(()) => {
            // Unified clean markdown format: ![name](source/<filename>)
            let url_path = format!("source/{}", final_filename);
            let markdown = format!(
                "![{}]({})",
                display_filename,
                url_path
            );
            log::info!("[upload_asset] saved → {} ({} bytes)", asset_path.display(), decoded.len());
            raw_json(serde_json::json!({
                "ok": true,
                "url": url_path,
                "path": url_path,
                "absolutePath": asset_path.to_string_lossy().to_string(),
                "size": decoded.len(),
                "mimeType": final_mime,
                "markdown": markdown,
            }))
        }
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
struct DeleteAssetRequest {
    path: String,
}

async fn delete_asset(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<DeleteAssetRequest>,
) -> impl IntoResponse {
    // Support workspace-scoped assets: "ws-asset/<ws_id>/<filename>"
    if req.path.starts_with("ws-asset/") {
        let rest = &req.path["ws-asset/".len()..];
        let slash = match rest.find('/') {
            Some(i) => i,
            None => return json_err(StatusCode::BAD_REQUEST, "Invalid ws-asset path"),
        };
        let ws_id = &rest[..slash];
        let relative = &rest[slash + 1..];

        if relative.contains("..") || ws_id.contains("..") {
            return json_err(StatusCode::FORBIDDEN, "Forbidden");
        }

        let workspaces = state.app.get_workspaces().await;
        let ws_root = match workspaces.iter().find(|w| w.id == ws_id) {
            Some(w) => std::path::PathBuf::from(&w.root),
            None => return json_err(StatusCode::NOT_FOUND, "Workspace not found"),
        };
        let actual_path = ws_root.join("source").join(relative);
        if actual_path.exists() {
            std::fs::remove_file(&actual_path).ok();
        }
        return raw_json(serde_json::json!({ "ok": true }));
    }

    // Legacy: global assets under data_root/assets
    let asset_dir = state.app.data_root.join("assets");
    let target = std::path::Path::new(&req.path);

    // Support old-style workspace source paths: "source/xxx.png" (not "source/assets/")
    if req.path.starts_with("source/") && !req.path.starts_with("source/assets/") {
        let rest = &req.path["source/".len()..];
        if rest.contains("..") {
            return json_err(StatusCode::FORBIDDEN, "Forbidden");
        }

        // Variant A: "source/ws_<id>/filename" — first segment is workspace id
        let segments: Vec<&str> = rest.splitn(2, '/').collect();
        if segments.len() == 2 && segments[0].starts_with("ws_") && !segments[1].is_empty() {
            let workspaces = state.app.get_workspaces().await;
            if let Some(ws) = workspaces.iter().find(|w| w.id == segments[0]) {
                for rel in [segments[1].to_string(), rest.to_string()] {
                    let candidate = std::path::PathBuf::from(&ws.root).join("source").join(&rel);
                    if candidate.exists() { std::fs::remove_file(&candidate).ok(); break; }
                    let candidate2 = std::path::PathBuf::from(&ws.root).join(&rel);
                    if candidate2.exists() { std::fs::remove_file(&candidate2).ok(); break; }
                }
                return raw_json(serde_json::json!({ "ok": true }));
            }
        }

        // Variant B: "source/filename" — plain file name, search all workspaces
        let workspaces = state.app.get_workspaces().await;
        for ws in &workspaces {
            if !ws.visible { continue; }
            let candidate = std::path::PathBuf::from(&ws.root).join("source").join(rest);
            if candidate.exists() && candidate.is_file() {
                std::fs::remove_file(&candidate).ok();
                return raw_json(serde_json::json!({ "ok": true }));
            }
            // Fuzzy: filename may contain a timestamp prefix
            let source_dir = std::path::PathBuf::from(&ws.root).join("source");
            if let Ok(entries) = std::fs::read_dir(&source_dir) {
                for entry in entries.flatten() {
                    if entry.path().is_file() {
                        if let Some(name) = entry.file_name().to_str() {
                            if name.contains(rest) {
                                std::fs::remove_file(entry.path()).ok();
                                return raw_json(serde_json::json!({ "ok": true }));
                            }
                        }
                    }
                }
            }
        }
        return raw_json(serde_json::json!({ "ok": true }));
    }

    let is_safe = target.starts_with(&asset_dir) ||
        (req.path.starts_with("source/assets/") || req.path.starts_with("assets/"));

    if !is_safe {
        return json_err(StatusCode::BAD_REQUEST, "Can only delete assets from the assets directory");
    }

    let actual_path = if target.exists() {
        target.to_path_buf()
    } else {
        let name = req.path.split('/').last().unwrap_or("");
        asset_dir.join(name)
    };

    if actual_path.exists() {
        std::fs::remove_file(&actual_path).ok();
    }

    raw_json(serde_json::json!({ "ok": true }))
}

// ── 资源文件服务 ──────────────────────────────────────

async fn serve_source(
    State(state): State<Arc<ServerState>>,
    Path(path): Path<String>,
) -> impl IntoResponse {
    log::info!("[serve_source] GET /source/{}", path);

    // Security: prevent path traversal
    if path.contains("..") {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }

    let filename = path.rsplit('/').next().unwrap_or(&path).to_string();
    let workspaces = state.app.get_workspaces().await;
    log::info!("[serve_source] filename={}, workspace_count={}", filename, workspaces.len());

    // ── 1. data_root (global assets: source/assets/xxx) ──
    let data_root_path = state.app.data_root.join(&path);
    log::info!("[serve_source] step1 data_root_path={}, exists={}", data_root_path.display(), data_root_path.exists());
    if data_root_path.exists() && data_root_path.is_file() {
        return serve_file(data_root_path);
    }

    // ── 2. Old ws_id prefix format: "source/ws_xxx/filename.webp" ──
    let segments: Vec<&str> = path.splitn(2, '/').collect();
    if segments.len() == 2 && segments[0].starts_with("ws_") && !segments[1].is_empty() {
        let ws_id = segments[0];
        let relative = segments[1];
        if let Some(ws) = workspaces.iter().find(|w| w.id == ws_id) {
            // Try exact: <root>/source/<filename>
            let candidate = std::path::PathBuf::from(&ws.root).join("source").join(relative);
            if candidate.exists() && candidate.is_file() {
                return serve_file(candidate);
            }
            // Try under root/ directly (oldest layout)
            let candidate2 = std::path::PathBuf::from(&ws.root).join(relative);
            if candidate2.exists() && candidate2.is_file() {
                return serve_file(candidate2);
            }
            // Fuzzy: scan all files in <root>/source/ looking for anything containing filename
            if let Ok(entries) = std::fs::read_dir(std::path::PathBuf::from(&ws.root).join("source")) {
                for entry in entries.flatten() {
                    if entry.path().is_file() {
                        if let Some(name) = entry.file_name().to_str() {
                            if name.contains(relative) {
                                return serve_file(entry.path());
                            }
                        }
                    }
                }
            }
        }
        // fall through to step 3 if ws_xxx not found
    }

    // ── 3. NEW primary format: "source/<filename>" → scan workspace source/ dirs ──
    //    a) Exact match first
    for ws in &workspaces {
        if !ws.visible { continue; }
        let candidate = std::path::PathBuf::from(&ws.root).join("source").join(&filename);
        if candidate.exists() && candidate.is_file() {
            return serve_file(candidate);
        }
    }

    //    b) Fuzzy: file with timestamp prefix that CONTAINS our filename
    //       e.g. we want "screenshot-xxx.webp" but file is "1787884967587_screenshot-xxx.webp"
    for ws in &workspaces {
        if !ws.visible { continue; }
        let source_dir = std::path::PathBuf::from(&ws.root).join("source");
        if let Ok(entries) = std::fs::read_dir(&source_dir) {
            for entry in entries.flatten() {
                if entry.path().is_file() {
                    if let Some(name) = entry.file_name().to_str() {
                        if name.contains(&filename) {
                            return serve_file(entry.path());
                        }
                    }
                }
            }
        }
    }

    //    c) Also try: join raw path (for "source/assets/xxx" without explicit assets segment)
    for ws in &workspaces {
        if !ws.visible { continue; }
        let candidate = std::path::PathBuf::from(&ws.root).join("source").join(&path);
        if candidate.exists() && candidate.is_file() {
            return serve_file(candidate);
        }
    }

    (StatusCode::NOT_FOUND, "Not Found").into_response()
}

/// Helper: read a local path and return binary response with correct MIME + cache header.
fn serve_file(path: std::path::PathBuf) -> axum::response::Response {
    use axum::body::Body;
    use axum::http::{HeaderMap, StatusCode};

    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    };

    match std::fs::read(&path) {
        Ok(data) => {
            let mut headers = HeaderMap::new();
            headers.insert("Content-Type", mime.parse().unwrap_or_else(|_| "application/octet-stream".parse().unwrap()));
            headers.insert("Cache-Control", "public, max-age=86400".parse().unwrap());
            (StatusCode::OK, headers, data).into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "Error reading file".to_string()).into_response(),
    }
}

/// Serve workspace-scoped assets: GET /ws-asset/:ws_id/<relative>
/// Resolves <workspace_root>/source/<relative> and serves the binary file.
async fn serve_ws_asset(
    State(state): State<Arc<ServerState>>,
    Path(params): Path<(String, String)>,
) -> impl IntoResponse {
    let (ws_id, relative) = params;

    // Security: prevent path traversal
    if relative.contains("..") || ws_id.contains("..") {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }

    let workspaces = state.app.get_workspaces().await;
    let ws_root = match workspaces.iter().find(|w| w.id == ws_id) {
        Some(w) => std::path::PathBuf::from(&w.root),
        None => return (StatusCode::NOT_FOUND, "Workspace not found").into_response(),
    };

    let file_path = ws_root.join("source").join(&relative);

    if !file_path.exists() || !file_path.is_file() {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }

    match std::fs::read(&file_path) {
        Ok(data) => {
            let ext = file_path.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let mime = match ext.as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "svg" => "image/svg+xml",
                "webp" => "image/webp",
                "mp4" => "video/mp4",
                "webm" => "video/webm",
                "pdf" => "application/pdf",
                _ => "application/octet-stream",
            };
            (StatusCode::OK, [("Content-Type", mime), ("Cache-Control", "public, max-age=86400")], data).into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "Error reading file").into_response(),
    }
}

#[derive(Deserialize)]
struct ImportRequest {
    // New format: frontend sends base64-encoded file content
    #[serde(rename = "fileData")]
    file_data: Option<String>,
    #[serde(rename = "fileName")]
    file_name: Option<String>,
    // Legacy format: plain text content
    content: Option<String>,
    filename: Option<String>,
    #[serde(rename = "workspaceId")]
    workspace_id: Option<String>,
}

async fn import_document(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<ImportRequest>,
) -> impl IntoResponse {
    use base64::Engine;

    // Resolve content: prefer base64 fileData (handles all file types), fall back to content
    let file_name = req.file_name.clone()
        .or(req.filename.clone())
        .unwrap_or_else(|| format!("import_{}.md", chrono::Utc::now().timestamp_millis()));

    let content = if let Some(b64) = req.file_data.as_deref() {
        // Try base64 decode
        match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(bytes) => {
                // Check if it's valid UTF-8 text; if not, try to treat as-is for md/txt
                match String::from_utf8(bytes) {
                    Ok(s) => s,
                    Err(_e) => {
                        // Binary file (.docx/.pdf/etc) — read raw bytes, report unsupported
                        return json_err(
                            StatusCode::BAD_REQUEST,
                            format!("不支持导入二进制格式：{}（请先转换为 Markdown/纯文本）", file_name),
                        );
                    }
                }
            }
            Err(_) => {
                // Not valid base64 — treat as plain text
                b64.to_string()
            }
        }
    } else if let Some(text) = req.content.as_deref() {
        text.to_string()
    } else {
        return json_err(StatusCode::BAD_REQUEST, "Missing fileData or content".to_string());
    };

    let ws_id = req.workspace_id.clone().filter(|id| !id.is_empty())
        .unwrap_or_else(|| "default".to_string());

    let safe_name = file_name
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    // Ensure .md extension for markdown storage
    let md_name = if !safe_name.to_lowercase().ends_with(".md") {
        format!("{}.md", safe_name.trim_end_matches(|c: char| c == '.' || c.is_whitespace()))
    } else {
        safe_name.clone()
    };

    let relative = format!("{}/{}", ws_id, md_name);

    match state.app.save_file(&relative, &content).await {
        Ok(hash) => raw_json(serde_json::json!({
            "ok": true,
            "path": relative,
            "contentSha256": hash,
            "filename": md_name,
        })),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct ExportRequest {
    // New format: frontend sends raw content + title + format
    content: Option<String>,
    format: Option<String>,
    title: Option<String>,
    // Legacy format: path-based
    path: Option<String>,
}

async fn export_document(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<ExportRequest>,
) -> impl IntoResponse {
    let format = req.format.as_deref().unwrap_or("md");
    let title = req.title.clone().unwrap_or_else(|| "document".to_string());
    let sanitized_title = title.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");

    let content = if let Some(c) = req.content.as_deref() {
        c.to_string()
    } else if let Some(p) = req.path.as_deref() {
        match state.app.read_file(p).await {
            Ok(entry) => entry.content,
            Err(e) => return json_err(StatusCode::NOT_FOUND, e.to_string()),
        }
    } else {
        return json_err(StatusCode::BAD_REQUEST, "Missing content or path".to_string());
    };

    // 统一 strip frontmatter（--- ... --- YAML 头）：
    // 导出文件的读者不需要知道「schema/title/created/status」这些写作元数据，
    // 用户明确要求"导出的文档不能有 frontmatter 块"，编辑/检索本端仍然保留原文件完整内容。
    let stripped = crate::frontmatter::split_frontmatter(&content).body.trim().to_string();
    let content_for_export = if stripped.is_empty() { content.clone() } else { stripped };

    let (mime, filename, body) = match format {
        "md" | "markdown" => (
            "text/markdown",
            format!("{}.md", sanitized_title),
            content_for_export,
        ),
        "txt" | "text" => (
            "text/plain; charset=utf-8",
            format!("{}.txt", sanitized_title),
            // TXT 走 Markdown → 纯文本：移除所有 Markdown 语法糖，
            // 保证导出的 .txt 不会残留 frontmatter / ``` / ## / ** 等语法。
            strip_markdown_for_txt(&content_for_export),
        ),
        "html" => (
            "text/html; charset=utf-8",
            format!("{}.html", sanitized_title),
            // HTML 导出交给前端本地生成（图片/样式/公式要内联 data URL，
            // Rust 端缺 CDN/渲染上下文。这里写一个最小"未生成"占位，
            // 前端收到 Content-Type=text/html 会走本地渲染兜底，
            // 并替换后端响应为真正的高品质 HTML 文档。
            format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head><body></body></html>", escape_html_attr(&sanitized_title)),
        ),
        "json" => {
            let json = serde_json::json!({
                "title": title,
                "content": content_for_export,
            });
            (
                "application/json",
                format!("{}.json", sanitized_title),
                serde_json::to_string_pretty(&json).unwrap_or_default(),
            )
        }
        _ => return json_err(StatusCode::BAD_REQUEST, format!("Unsupported format: {}", format)),
    };

    // Return binary blob response so frontend can do resp.blob() directly
    use axum::http::{HeaderMap, StatusCode};
    use axum::body::Body;

    let mut headers = HeaderMap::new();
    headers.insert("Content-Type", mime.parse().unwrap_or_else(|_| "text/plain".parse().unwrap()));
    if let Ok(disposition) = format!("attachment; filename=\"{}\"", filename.replace('"', "_")).parse::<axum::http::HeaderValue>() {
        headers.insert("Content-Disposition", disposition);
    }
    (StatusCode::OK, headers, body.into_bytes().to_vec()).into_response()
}

/// 后端端纯文本(.txt)导出：轻量 Markdown 语法糖剥离，避免 frontmatter / 代码标记 / 标题符号漏进 .txt。
/// 保留实际语义文本；列表项以「- / N.」原样保留；代码块保留文字内容(不含 ``` 包裹行)。
fn strip_markdown_for_txt(md: &str) -> String {
    let text = md;
    // 1) fenced ```...```  / ```lang：删除包裹行，内容保留（去掉首行语言标记后代码主体可读）
    let mut in_fence = false;
    let mut stripped_lines: Vec<String> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            stripped_lines.push(line.to_string());
            continue;
        }
        let mut s = line.to_string();
        // 2) ATX 标题：# ## ### ## 前缀去掉
        if let Some(rest) = s.strip_prefix(|c: char| c == '#' || c == ' ') {
            // noop: we use regex style procedural below
            let _ = rest;
        }
        let bytes: &[u8] = s.as_bytes();
        let mut leading_hash = 0usize;
        while leading_hash < bytes.len() && bytes[leading_hash] == b'#' {
            leading_hash += 1;
        }
        if leading_hash > 0
            && leading_hash <= 6
            && (leading_hash == bytes.len()
                || bytes.get(leading_hash) == Some(&b' ')
                || bytes.get(leading_hash) == Some(&b'\t'))
        {
            s = s[leading_hash..].trim_start().to_string();
        }
        // 3) setext 下划线标题（上一行已非空 + 本行全 ==== 或 ----）：删除下划线行
        let is_setext_underline = {
            let t = s.trim();
            !t.is_empty()
                && ((t.chars().all(|c| c == '=') && t.len() >= 2)
                    || (t.chars().all(|c| c == '-') && t.len() >= 2))
        };
        if is_setext_underline {
            continue;
        }
        // 4) 引用块前缀 > 去掉
        if let Some(rest) = s.strip_prefix("> ") {
            s = rest.to_string();
        } else if let Some(rest) = s.strip_prefix('>') {
            s = rest.to_string();
        }
        // 5) 行内 emphasis：**粗** / *斜* / __粗__ / _斜_ / `code` / ~~删除线~~
        s = strip_inline_markers(&s, "**");
        s = strip_inline_markers(&s, "__");
        s = strip_inline_markers(&s, "~~");
        s = strip_inline_backticks(&s);
        // 单 * / _ 斜体：成对出现才删（中间至少 1 字符，避免纯破折号/列表受影响）
        s = strip_simple_pair(&s, '*');
        s = strip_simple_pair(&s, '_');
        // 6) 行内/引用图片：![alt](url) → alt；链接 [text](url) → text
        s = strip_images_and_links(&s);
        // 7) HTML 注释 <!-- ... --> 去掉
        s = strip_html_comments(&s);
        stripped_lines.push(s);
    }
    // 8) 合并过多连续空行（最多 1 条空行）
    let mut out: Vec<String> = Vec::new();
    let mut prev_blank = false;
    for line in stripped_lines {
        let blank = line.trim().is_empty();
        if blank && prev_blank {
            continue;
        }
        prev_blank = blank;
        out.push(line);
    }
    // 去首尾空行
    while out.first().map(|l| l.trim().is_empty()).unwrap_or(false) {
        out.remove(0);
    }
    while out.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        out.pop();
    }
    out.join("\n")
}

fn strip_inline_markers(s: &str, marker: &str) -> String {
    let mut out = s.to_string();
    loop {
        let Some(open) = out.find(marker) else { break };
        let after_open = open + marker.len();
        let Some(close) = out[after_open..].find(marker) else { break };
        let close_abs = after_open + close;
        // 中间必须非空，避免把独立 marker 误当成开/闭
        if close_abs <= after_open {
            break;
        }
        out.replace_range(close_abs..close_abs + marker.len(), "");
        out.replace_range(open..open + marker.len(), "");
    }
    out
}

fn strip_inline_backticks(s: &str) -> String {
    let mut out = s.to_string();
    loop {
        let Some(open) = out.find('`') else { break };
        let after_open = open + 1;
        let Some(close) = out[after_open..].find('`') else { break };
        let close_abs = after_open + close;
        if close_abs <= after_open {
            break;
        }
        out.replace_range(close_abs..=close_abs, "");
        out.replace_range(open..=open, "");
    }
    out
}

fn strip_simple_pair(s: &str, ch: char) -> String {
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    let mut res: Vec<char> = Vec::with_capacity(n);
    let mut i = 0;
    while i < n {
        let c = chars[i];
        if c == ch {
            // 尝试在 i 之后找到配对：前 ch 必须夹在"非空白/非ch"之间，且后 ch 之前有至少 1 非 ch 字符
            // 宽松策略：找到下一个"不是紧邻 ch 的独立边界"ch；匹配成功就跳过两个 ch，中间保留
            let mut j = i + 1;
            let mut any_inner = false;
            while j < n {
                if chars[j] == ch {
                    if any_inner {
                        // 匹配，跳过 i 的 ch 与 j 的 ch，中间原样写入
                        for k in (i + 1)..j {
                            res.push(chars[k]);
                        }
                        i = j + 1;
                        break;
                    }
                    // 连续 ch，当成普通字符
                    j += 1;
                    continue;
                }
                if !chars[j].is_whitespace() {
                    any_inner = true;
                }
                j += 1;
            }
            if j < n {
                // 已处理
                continue;
            } else {
                // 未匹配，保留当前 ch
                res.push(c);
                i += 1;
            }
        } else {
            res.push(c);
            i += 1;
        }
    }
    res.into_iter().collect()
}

fn strip_images_and_links(s: &str) -> String {
    // 先处理 ![alt](url) → alt，再处理 [text](url) → text
    // 使用 OnceLock 预编译避免循环里反复 new Regex (regex 1.x 手工 new 性能无碍但这样更干净)
    use std::sync::OnceLock;
    static IMG_RE: OnceLock<regex::Regex> = OnceLock::new();
    static LINK_RE: OnceLock<regex::Regex> = OnceLock::new();
    let img = IMG_RE.get_or_init(|| regex::Regex::new(r#"!\[([^\]]*)\]\(([^)]+)\)"#).unwrap());
    let link = LINK_RE.get_or_init(|| regex::Regex::new(r#"(^|[^!])\[([^\]]+)\]\(([^)]+)\)"#).unwrap());
    let step1 = img.replace_all(s, "$1").into_owned();
    link.replace_all(&step1, "${1}${2}").into_owned()
}

fn strip_html_comments(s: &str) -> String {
    let mut out = s.to_string();
    loop {
        let Some(op) = out.find("<!--") else { break };
        let Some(cl) = out[op..].find("-->") else { break };
        let cl_abs = op + cl + "-->".len();
        out.replace_range(op..cl_abs, "");
    }
    out
}

fn escape_html_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// ── 语义标签 ──────────────────────────────────────────

#[derive(Deserialize)]
struct SemanticTagsRequest {
    text: String,
}

async fn semantic_tags(
    Json(req): Json<SemanticTagsRequest>,
) -> impl IntoResponse {
    // Extract tags from text using basic NLP heuristics
    let tags = crate::utils::extract_semantic_tags(&req.text);
    raw_json(serde_json::json!({
        "ok": true,
        "tags": tags,
    }))
}

// ── Markdown 规范化 ──────────────────────────────────

#[derive(Deserialize)]
struct NormalizeMdRequest {
    text: String,
}

async fn normalize_md(
    Json(req): Json<NormalizeMdRequest>,
) -> impl IntoResponse {
    let normalized = crate::frontmatter::normalize_markdown(&req.text);
    raw_json(serde_json::json!({
        "ok": true,
        "text": normalized,
    }))
}

// ── Agent 策略 ──────────────────────────────────────

#[derive(Deserialize)]
struct AgentPolicyQuery {
    #[serde(rename = "workspaceId")]
    workspace_id: Option<String>,
}

async fn get_agent_policy(
    State(state): State<Arc<ServerState>>,
    Query(params): Query<AgentPolicyQuery>,
) -> impl IntoResponse {
    let ws_id = params.workspace_id.unwrap_or_else(|| "default".to_string());
    let workspaces = state.app.get_workspaces().await;
    let ws = workspaces.iter().find(|w| w.id == ws_id);

    match ws {
        Some(workspace) => {
            let policy = crate::agent_policy::load_policy(&workspace.root);
            raw_json(serde_json::json!({
                "ok": true,
                "workspaceId": ws_id,
                "policy": policy,
            }))
        }
        None => json_err(StatusCode::NOT_FOUND, "Workspace not found"),
    }
}

#[derive(Deserialize)]
struct CreateAgentPolicyRequest {
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    confirmed: Option<bool>,
}

async fn create_agent_policy(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<CreateAgentPolicyRequest>,
) -> impl IntoResponse {
    if req.confirmed != Some(true) {
        return json_err(StatusCode::BAD_REQUEST, "Confirmation required");
    }

    let workspaces = state.app.get_workspaces().await;
    let ws = workspaces.iter().find(|w| w.id == req.workspace_id);

    match ws {
        Some(workspace) => {
            match crate::agent_policy::create_policy(&workspace.root) {
                Ok(policy) => raw_json(serde_json::json!({
                    "ok": true,
                    "workspaceId": req.workspace_id,
                    "policy": policy,
                })),
                Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
            }
        }
        None => json_err(StatusCode::NOT_FOUND, "Workspace not found"),
    }
}

// ── 更新检查 ──────────────────────────────────────────

#[derive(Deserialize)]
struct CheckUpdateRequest {
    #[serde(rename = "currentVersion")]
    current_version: Option<String>,
}

async fn check_update(
    Json(req): Json<CheckUpdateRequest>,
) -> impl IntoResponse {
    let current = req.current_version.unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    // 拉取远程最新版本信息
    match fetch_remote_version().await {
        Ok(remote) => {
            let latest = remote
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let up_to_date = latest.is_empty()
                || cmp_versions(&latest, &current) != std::cmp::Ordering::Greater;

            let mut resp = remote.clone();
            resp["ok"] = serde_json::Value::Bool(true);
            resp["currentVersion"] = serde_json::Value::String(current.clone());
            resp["latestVersion"] = serde_json::Value::String(latest.clone());
            resp["upToDate"] = serde_json::Value::Bool(up_to_date);

            raw_json(resp)
        }
        Err(e) => {
            // 远程不可达，降级为 upToDate=true + warning
            eprintln!("[check_update] 远程不可达: {}", e);
            raw_json(serde_json::json!({
                "ok": true,
                "currentVersion": current,
                "latestVersion": current,
                "upToDate": true,
                "warning": format!("无法连接到更新服务器: {}", e),
                "downloadUrl": format!(
                    "https://mytemple.fshby.cc/downloads/MyTempleKnowledge_Setup_v{}.exe",
                    current
                ),
            }))
        }
    }
}

// ── 视频上传 ──────────────────────────────────────────

#[derive(Deserialize)]
struct UploadVideoRequest {
    #[serde(rename = "filename")]
    filename: String,
    #[serde(rename = "base64")]
    base64_data: String,
}

async fn upload_video(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<UploadVideoRequest>,
) -> impl IntoResponse {
    use base64::Engine;
    
    // Decode base64 data
    let decoded = match base64::engine::general_purpose::STANDARD.decode(&req.base64_data) {
        Ok(bytes) => bytes,
        Err(e) => return json_err(StatusCode::BAD_REQUEST, format!("Invalid base64 data: {}", e)),
    };
    
    // Ensure videos directory
    let video_dir = state.app.data_root.join("assets").join("videos");
    std::fs::create_dir_all(&video_dir).ok();
    
    // Safe filename
    let safe_name = req.filename
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    let unique_name = format!("{}_{}", 
        chrono::Utc::now().timestamp_millis(),
        safe_name
    );
    
    let video_path = video_dir.join(&unique_name);
    
    match std::fs::write(&video_path, &decoded) {
        Ok(()) => {
            let url_path = format!("source/assets/videos/{}", unique_name);
            raw_json(serde_json::json!({
                "ok": true,
                "url": url_path,
                "filename": unique_name,
                "size": decoded.len(),
            }))
        }
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to save video: {}", e)),
    }
}

// ── 工作区粘贴 ──────────────────────────────────────────

#[derive(Deserialize)]
struct PasteWorkspaceRequest {
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    action: String,  // "copy" or "cut"
    #[serde(rename = "sourcePaths")]
    source_paths: Vec<String>,
    #[serde(rename = "destPath")]
    dest_path: String,
}

async fn paste_workspace(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<PasteWorkspaceRequest>,
) -> impl IntoResponse {
    let mut results = Vec::new();
    
    for source in &req.source_paths {
        // Read the file
        match state.app.read_file(source).await {
            Ok(entry) => {
                // Determine target path
                let source_name = std::path::Path::new(source)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("untitled");
                let target = format!("{}/{}", req.dest_path, source_name);
                
                if req.action == "copy" {
                    match state.app.save_file(&target, &entry.content).await {
                        Ok(_) => results.push(serde_json::json!({
                            "source": source,
                            "target": target,
                            "action": "copy",
                            "ok": true,
                        })),
                        Err(e) => results.push(serde_json::json!({
                            "source": source,
                            "ok": false,
                            "error": e.to_string(),
                        })),
                    }
                } else if req.action == "cut" {
                    match state.app.save_file(&target, &entry.content).await {
                        Ok(_) => {
                            // Delete source after copy
                            let _ = state.app.delete_file(source).await;
                            results.push(serde_json::json!({
                                "source": source,
                                "target": target,
                                "action": "cut",
                                "ok": true,
                            }));
                        }
                        Err(e) => results.push(serde_json::json!({
                            "source": source,
                            "ok": false,
                            "error": e.to_string(),
                        })),
                    }
                } else {
                    results.push(serde_json::json!({
                        "source": source,
                        "ok": false,
                        "error": format!("Unknown action: {}", req.action),
                    }));
                }
            }
            Err(e) => {
                results.push(serde_json::json!({
                    "source": source,
                    "ok": false,
                    "error": e.to_string(),
                }));
            }
        }
    }
    
    raw_json(serde_json::json!({
        "ok": true,
        "results": results,
    }))
}

// ── 目录浏览 ──────────────────────────────────────────

#[derive(Deserialize)]
struct BrowseDirectoryRequest {
    path: Option<String>,
    action: Option<String>,
}

async fn browse_directory(
    State(state): State<Arc<ServerState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    // Support both POST body JSON and GET query params
    let (path_opt, action) = if body.is_empty() {
        // GET: parse query string from the URL
        // Tauri passes query params via extract; we read from the handler manually
        // For GET requests we can't easily extract query params here, so we handle
        // action=roots via a separate GET handler registered below
        (None, None)
    } else {
        match serde_json::from_slice::<BrowseDirectoryRequest>(&body) {
            Ok(req) => (req.path, req.action),
            Err(_) => (None, None),
        }
    };

    let action = action.unwrap_or_else(|| "list".to_string());

    // Support action=roots: return common root directories + favorites
    if action == "roots" {
        let favorites = vec![
            serde_json::json!({ "label": "文档", "value": dirs_default().join("Documents").to_string_lossy() }),
            serde_json::json!({ "label": "桌面", "value": dirs_default().join("Desktop").to_string_lossy() }),
            serde_json::json!({ "label": "下载", "value": dirs_default().join("Downloads").to_string_lossy() }),
            serde_json::json!({ "label": "主目录", "value": dirs_default().to_string_lossy() }),
        ];
        let roots = list_windows_drives();
        return raw_json(serde_json::json!({
            "ok": true,
            "roots": roots,
            "favorites": favorites,
        }));
    }

    // action=list (default): list directory contents
    // 健壮的路径 fallback：空串 / 全空白 / None 都视为默认路径；
    // 若 data_root 本身不存在则进一步回退到用户主目录，避免 400 误报。
    let raw = path_opt.unwrap_or_default();
    let trimmed = raw.trim();
    let data_root_str = state.app.data_root.to_string_lossy().to_string();
    let browse_path = if trimmed.is_empty() {
        let dr = std::path::Path::new(&data_root_str);
        if dr.exists() && dr.is_dir() {
            data_root_str
        } else {
            let home = dirs_default();
            if home.exists() && home.is_dir() {
                home.to_string_lossy().to_string()
            } else {
                data_root_str
            }
        }
    } else {
        trimmed.to_string()
    };
    let path = std::path::Path::new(&browse_path);

    if !path.exists() || !path.is_dir() {
        return json_err(StatusCode::BAD_REQUEST, format!("Directory not found: {}", browse_path));
    }

    let mut items: Vec<serde_json::Value> = Vec::new();
    let mut dirs: Vec<String> = Vec::new();
    let mut parent: Option<String> = None;

    // Compute parent path
    if let Some(parent_path) = path.parent() {
        if !parent_path.as_os_str().is_empty() {
            parent = Some(parent_path.to_string_lossy().to_string());
        }
    }

    // Build breadcrumbs
    let mut breadcrumbs: Vec<serde_json::Value> = Vec::new();
    let mut breadcrumb_path = std::path::PathBuf::new();
    for component in path.components() {
        breadcrumb_path.push(component.as_os_str());
        let name = component.as_os_str().to_string_lossy().to_string();
        breadcrumbs.push(serde_json::json!({
            "name": name,
            "path": breadcrumb_path.to_string_lossy().to_string(),
        }));
    }

    match std::fs::read_dir(path) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let entry_path = entry.path().to_string_lossy().to_string();
                if let Ok(metadata) = entry.metadata() {
                    if metadata.is_dir() {
                        dirs.push(entry_path.clone());
                        items.push(serde_json::json!({
                            "name": name,
                            "path": entry_path,
                            "type": "directory",
                        }));
                    }
                }
            }
            // Sort: directories first, then alphabetically
            items.sort_by(|a, b| {
                let a_dir = a.get("type").and_then(|t| t.as_str()) == Some("directory");
                let b_dir = b.get("type").and_then(|t| t.as_str()) == Some("directory");
                b_dir.cmp(&a_dir)
                    .then(a.get("name").and_then(|n| n.as_str()).cmp(&b.get("name").and_then(|n| n.as_str())))
            });
        }
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read directory: {}", e)),
    }

    raw_json(serde_json::json!({
        "ok": true,
        "current": browse_path,
        "parent": parent,
        "breadcrumbs": breadcrumbs,
        "items": items,
        "dirs": dirs,
    }))
}

/// GET /api/browse-directory?action=roots
/// Returns common root directories + favorites for the file browser
async fn browse_directory_roots(
    State(_state): State<Arc<ServerState>>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let action = params.get("action").cloned().unwrap_or_default();
    if action == "roots" {
        let home = dirs_default();
        let favorites = vec![
            serde_json::json!({ "label": "文档", "value": home.join("Documents").to_string_lossy() }),
            serde_json::json!({ "label": "桌面", "value": home.join("Desktop").to_string_lossy() }),
            serde_json::json!({ "label": "下载", "value": home.join("Downloads").to_string_lossy() }),
            serde_json::json!({ "label": "主目录", "value": home.to_string_lossy() }),
        ];
        let roots = list_windows_drives();
        return raw_json(serde_json::json!({
            "ok": true,
            "roots": roots,
            "favorites": favorites,
        }));
    }
    raw_json(serde_json::json!({ "ok": true, "roots": [], "favorites": [] }))
}

/// Get user's home directory (cross-platform)
fn dirs_default() -> std::path::PathBuf {
    std::env::var("USERPROFILE")
        .map(std::path::PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(std::path::PathBuf::from))
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// List Windows drive letters (C:\, D:\, etc.)
fn list_windows_drives() -> Vec<serde_json::Value> {
    let mut drives = Vec::new();
    for letter in b'C'..=b'Z' {
        let drive = format!("{}:\\", letter as char);
        let path = std::path::Path::new(&drive);
        if path.exists() {
            drives.push(serde_json::json!({
                "label": drive.clone(),
                "value": drive,
            }));
        }
    }
    if drives.is_empty() {
        // Non-Windows fallback: return root
        drives.push(serde_json::json!({
            "label": "/",
            "value": "/",
        }));
    }
    drives
}

// ── Agent 操作预览 ──────────────────────────────────

#[derive(Deserialize)]
struct AgentActionPreviewRequest {
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    action: String,
    #[serde(rename = "targetPath")]
    target_path: Option<String>,
}

async fn agent_action_preview(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<AgentActionPreviewRequest>,
) -> impl IntoResponse {
    // Preview what an agent action would do without actually doing it
    let workspaces = state.app.get_workspaces().await;
    let ws = workspaces.iter().find(|w| w.id == req.workspace_id);
    
    let _policy = match ws {
        Some(workspace) => crate::agent_policy::load_policy(&workspace.root),
        None => return json_err(StatusCode::NOT_FOUND, "Workspace not found"),
    };
    
    // For now, return a generic preview based on the action
    let preview = match req.action.as_str() {
        "create" => serde_json::json!({
            "action": "create",
            "description": "Would create a new file or directory",
            "targetPath": req.target_path,
            "safe": true,
        }),
        "delete" => serde_json::json!({
            "action": "delete",
            "description": "Would delete the specified file or directory",
            "targetPath": req.target_path,
            "safe": false,
            "warning": "Deletion is irreversible",
        }),
        "move" => serde_json::json!({
            "action": "move",
            "description": "Would move a file or directory to a new location",
            "targetPath": req.target_path,
            "safe": true,
        }),
        _ => serde_json::json!({
            "action": req.action,
            "description": "Unknown action",
            "safe": false,
        }),
    };
    
    raw_json(serde_json::json!({
        "ok": true,
        "preview": preview,
        "policy": "active",
    }))
}

// ── Agent 操作应用 ──────────────────────────────────

#[derive(Deserialize)]
struct AgentActionApplyRequest {
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    action: String,
    #[serde(rename = "targetPath")]
    target_path: Option<String>,
    #[serde(rename = "confirmed")]
    confirmed: bool,
}

async fn agent_action_apply(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<AgentActionApplyRequest>,
) -> impl IntoResponse {
    if !req.confirmed {
        return json_err(StatusCode::BAD_REQUEST, "Action not confirmed");
    }
    
    let workspaces = state.app.get_workspaces().await;
    let ws = workspaces.iter().find(|w| w.id == req.workspace_id);
    
    if ws.is_none() {
        return json_err(StatusCode::NOT_FOUND, "Workspace not found");
    }
    
    // Apply the action (simplified implementation)
    match req.action.as_str() {
        "delete" => {
            if let Some(path) = &req.target_path {
                match state.app.delete_file(path).await {
                    Ok(_) => raw_json(serde_json::json!({
                        "ok": true,
                        "action": "delete",
                        "path": path,
                    })),
                    Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
                }
            } else {
                json_err(StatusCode::BAD_REQUEST, "targetPath required for delete")
            }
        }
        "create" => {
            if let Some(path) = &req.target_path {
                match state.app.save_file(path, "").await {
                    Ok(_) => raw_json(serde_json::json!({
                        "ok": true,
                        "action": "create",
                        "path": path,
                    })),
                    Err(e) => json_err(StatusCode::BAD_REQUEST, e.to_string()),
                }
            } else {
                json_err(StatusCode::BAD_REQUEST, "targetPath required for create")
            }
        }
        _ => json_err(StatusCode::BAD_REQUEST, format!("Unknown action: {}", req.action)),
    }
}

// ── 授权管理 Handler ──────────────────────────────────────

/// 授权文件名
const LICENSE_FILENAME: &str = ".license";

/// 获取授权文件路径（data_root/.license）
fn license_file_path(data_root: &std::path::Path) -> std::path::PathBuf {
    data_root.join(LICENSE_FILENAME)
}

/// 读取已保存的授权码（若存在）
fn read_saved_license(data_root: &std::path::Path) -> Option<String> {
    let path = license_file_path(data_root);
    std::fs::read_to_string(&path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// GET /api/license/status
/// 返回授权状态概要（机器码、时间戳、时钟篡改检测）
async fn license_status(
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    let data_root = state.app.data_root.clone();
    let status = crate::license::get_license_status(&data_root);
    raw_json(status)
}

/// GET /api/license/check
/// 检查本地授权文件是否存在并验证，返回 { activated, machineCode, ... }
async fn license_check(
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    let data_root = state.app.data_root.clone();
    let machine_code = crate::license::get_machine_code();

    match read_saved_license(&data_root) {
        None => {
            raw_json(serde_json::json!({
                "activated": false,
                "machineCode": machine_code,
            }))
        }
        Some(key) => {
            let result = crate::license::verify_license(&key, &data_root);
            // 合并 activated 字段与 LicenseResult 全部字段
            let mut obj = serde_json::to_value(&result).unwrap_or_default();
            if let Some(map) = obj.as_object_mut() {
                map.insert("activated".to_string(), serde_json::Value::Bool(result.valid));
            }
            raw_json(obj)
        }
    }
}

/// POST /api/license/activate
/// 请求体: { licenseKey: string }
/// 验证授权码，若有效则保存到本地
async fn license_activate(
    State(state): State<Arc<ServerState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ActivateRequest {
        license_key: String,
    }

    let req: ActivateRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => return json_err(StatusCode::BAD_REQUEST, "请求格式错误"),
    };

    let key = req.license_key.trim();
    if key.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "请输入授权码");
    }

    let data_root = state.app.data_root.clone();
    let result = crate::license::verify_license(key, &data_root);

    if result.valid {
        // 保存授权码到本地文件
        let path = license_file_path(&data_root);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(&path, key) {
            log::warn!("保存授权文件失败: {}", e);
        }
    }

    raw_json(serde_json::to_value(&result).unwrap_or_default())
}

/// POST /api/license/deactivate
/// 删除本地授权文件
async fn license_deactivate(
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    let data_root = state.app.data_root.clone();
    let path = license_file_path(&data_root);
    let _ = std::fs::remove_file(&path);
    let machine_code = crate::license::get_machine_code();
    raw_json(serde_json::json!({
        "activated": false,
        "machineCode": machine_code,
    }))
}
