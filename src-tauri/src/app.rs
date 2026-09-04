// // app.rs - 全局应用状态管理
// 替代 Node.js server.js 中的全局缓存、工作区管理、文件索引等模块

use serde::{Deserialize, Serialize};

use std::collections::HashMap;

use std::path::{Path, PathBuf};

use std::sync::Arc;

use tokio::sync::RwLock;

use walkdir::WalkDir;

use sha2::Digest;

use unicode_normalization::UnicodeNormalization;



pub const DEFAULT_WORKSPACE_ID: &str = "default";

/// Unicode NFC 归一化：保证 Mac HFS+ (NFD 分解式) 与 Win NTFS / NAS (NFC 合成式)
/// 的相同视觉中文字符，在 String == 比较、HashMap key、file cache 查询时 100% 命中。
/// 全局搜索搜索结果 ref_path 来自 scan_workspace；openDoc 输入来自前端 click dataset，
/// 两处都经由 nfc() 后再比较，消除 NFC/NFD 不一致导致的 cache 漏查（搜得到但点不开）。
#[inline]
pub fn nfc<S: AsRef<str>>(s: S) -> String {
    s.as_ref().nfc().collect::<String>()
}

/// 取路径 basename（忽略尾部 /，跨正反斜杠），再做 NFC。
/// 用于 read_file 三级弱匹配兜底的 basename 精确匹配。
pub fn nfc_basename<S: AsRef<str>>(path: S) -> String {
    let p = path.as_ref().trim_end_matches('/').trim_end_matches('\\');
    let base = match (p.rfind('/'), p.rfind('\\')) {
        (Some(a), Some(b)) => &p[a.max(b) + 1..],
        (Some(a), None) => &p[a + 1..],
        (None, Some(b)) => &p[b + 1..],
        (None, None) => p,
    };
    nfc(base)
}

/// UTF-32 手工解码器（encoding_rs crate 未单独导出 UTF_32_LE / UTF_32_BE 静态）。
/// 每 4 字节按端序取 u32，转 char 后 push；非法码位返回 None（由外层走 UTF-8 lossy）。
pub fn decode_utf32(body: &[u8], little_endian: bool) -> Option<String> {
    if body.len() % 4 != 0 { return None; }
    let mut out = String::with_capacity(body.len() / 4);
    for chunk in body.chunks_exact(4) {
        let u = if little_endian {
            u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        } else {
            u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        };
        match char::from_u32(u) {
            Some(c) => out.push(c),
            None => return None,
        }
    }
    Some(out)
}

/// 智能解码原始字节 -> (UTF-8 字符串, 识别出的编码标签)
/// 优先级：UTF-8 strict -> BOM 检测 (UTF8 / UTF16 LE/BE / UTF32 LE/BE)
///       -> encoding_rs (GBK / GB18030 / Big5 / EUC-KR / Shift_JIS)
///       -> 最后 lossy UTF-8（替换非法字节，保证 UI 不空白）
/// 江西电信 WPS 导出 md 默认 GBK；中文 Win 记事本另存常用 UTF16 LE BOM。
pub fn decode_bytes_smart(raw: &[u8]) -> (String, String) {
    use encoding_rs::*;

    // 1) 尝试纯 UTF-8（无 BOM）
    if let Ok(s) = std::str::from_utf8(raw) {
        return (s.to_string(), "utf-8".into());
    }

    // 2) BOM 优先（匹配后跳过对应字节长度再解码）
    if raw.len() >= 3 && &raw[0..3] == b"\xef\xbb\xbf" {
        // UTF-8 BOM
        let body = &raw[3..];
        let (cow, _enc, _had_err) = UTF_8.decode(body);
        return (cow.into_owned(), "utf-8-bom".into());
    }
    if raw.len() >= 4 && &raw[0..4] == b"\xff\xfe\x00\x00" {
        // UTF-32 LE BOM：手工按 4 字节切小端 u16，避免依赖 encoding_rs 未导出的 UTF_32_LE
        let body = &raw[4..];
        let decoded = decode_utf32(body, /*little_endian*/ true);
        return (decoded.unwrap_or_else(|| String::from_utf8_lossy(body).into_owned()), "utf-32le-bom".into());
    }
    if raw.len() >= 4 && &raw[0..4] == b"\x00\x00\xfe\xff" {
        // UTF-32 BE BOM：encoding_rs 不单独导出 UTF_32_BE，手工解码
        let body = &raw[4..];
        let decoded = decode_utf32(body, /*little_endian*/ false);
        return (decoded.unwrap_or_else(|| String::from_utf8_lossy(body).into_owned()), "utf-32be-bom".into());
    }
    if raw.len() >= 2 && &raw[0..2] == b"\xff\xfe" {
        // UTF-16 LE BOM
        let body = &raw[2..];
        let (cow, _enc, _had_err) = UTF_16LE.decode(body);
        return (cow.into_owned(), "utf-16le-bom".into());
    }
    if raw.len() >= 2 && &raw[0..2] == b"\xfe\xff" {
        // UTF-16 BE BOM
        let body = &raw[2..];
        let (cow, _enc, _had_err) = UTF_16BE.decode(body);
        return (cow.into_owned(), "utf-16be-bom".into());
    }

    // 3) encoding_rs 猜测序列（中文环境下命中概率由高到低，GB18030 兼容 GBK）
    // 注意：encoding_rs 导出名 BIG5（不是 BIG5_2003）、SHIFT_JIS（不是 SHIFTJIS）
    let candidates: &[&Encoding] = &[
        GB18030, GBK, BIG5, SHIFT_JIS, EUC_KR, WINDOWS_1252,
    ];
    for enc in candidates {
        // 非侵入式：尝试 decode 后判断是否产生大量替换字符
        let (cow, _used_encoding, had_errors) = enc.decode(raw);
        // 启发：若解码没替换错误 或 替换比例极低(<0.1%)，接受该编码
        if !had_errors {
            return (cow.into_owned(), enc.name().to_string().to_ascii_lowercase());
        }
        let sub_count = cow.matches('\u{fffd}').count();
        if cow.len() > 1000 && (sub_count as f64 / cow.len() as f64) < 0.001 {
            return (cow.into_owned(), enc.name().to_string().to_ascii_lowercase());
        }
    }

    // 4) 终级兜底：UTF-8 lossy 替换非法字节，保证 UI 不空白，用户可见乱码后可自行改编码
    let (cow, _enc, _had_err) = UTF_8.decode(raw);
    (cow.into_owned(), "utf-8-lossy".into())
}

/// 对齐字符边界工具（中文字节切片不会 panic）：
/// 把 start/end 向最近的 char boundary 内缩。与项目 memory 中 align_boundary 规则保持一致。
#[allow(dead_code)]
pub fn align_boundary(text: &str, mut start: usize, mut end: usize) -> (usize, usize) {
    if start > end { std::mem::swap(&mut start, &mut end); }
    let bytes = text.as_bytes();
    while start < bytes.len() && (bytes[start] as i8) > -0x41 && (bytes[start] as i8) < -0x80 {
        start = start.saturating_add(1);
    }
    while end > start && end < bytes.len() && (bytes[end] as i8) > -0x41 && (bytes[end] as i8) < -0x80 {
        end = end.saturating_sub(1);
    }
    (start.min(text.len()), end.min(text.len()))
}



#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {

    pub id: String,

    pub name: String,

    pub root: String,

    #[serde(default = "default_true")]
    pub visible: bool,

    #[serde(default)]
    pub last_used: u64,

    #[serde(default)]
    pub md_only: bool,

}

fn default_true() -> bool { true }



/// 全局字符串字典：tags/terms 存 Vec<u32> token id，节省内存
pub struct TokenDictionary {
    forward: std::sync::RwLock<std::collections::HashMap<String, u32>>,
    reverse: std::sync::RwLock<Vec<String>>,
}
impl TokenDictionary {
    pub fn new() -> Self {
        Self { forward: std::sync::RwLock::new(std::collections::HashMap::new()), reverse: std::sync::RwLock::new(Vec::new()) }
    }
    pub fn intern(&self, s: &str) -> u32 {
        { if let Some(&id) = self.forward.read().unwrap().get(s) { return id; } }
        let mut fwd = self.forward.write().unwrap();
        if let Some(&id) = fwd.get(s) { return id; }
        let mut rev = self.reverse.write().unwrap();
        let id = rev.len() as u32;
        rev.push(s.to_string());
        fwd.insert(s.to_string(), id);
        id
    }
    pub fn lookup_many(&self, ids: &[u32]) -> Vec<String> {
        let rev = self.reverse.read().unwrap();
        ids.iter().filter_map(|&id| rev.get(id as usize).cloned()).collect()
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {

    pub path: String,

    pub absolute: String,

    pub title: String,

    pub workspace_id: String,

    pub workspace_name: String,

    pub content: Option<String>,

    pub content_sha256: String,

    pub plain: String,

    pub tags: Vec<u32>,

    pub terms: Vec<u32>,

    pub created: u64,

    pub modified: u64,

    pub encoding: String,

}



#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {

    pub name: String,

    pub path: String,

    #[serde(rename = "type")]
    pub node_type: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<u64>,

    pub children: Vec<TreeNode>,

}



#[derive(Clone)]

pub struct AppState {

    pub data_root: PathBuf,

    pub workspaces: Arc<RwLock<Vec<Workspace>>>,

    pub default_workspace_id: Arc<RwLock<String>>,

    pub files: Arc<RwLock<Vec<FileEntry>>>,

    pub tree: Arc<RwLock<Option<TreeNode>>>,

    pub search_index: Arc<RwLock<SearchIndex>>,

    pub token_dict: Arc<TokenDictionary>,

}



#[derive(Debug, Default, Clone)]

pub struct SearchIndex {

    pub entries: Vec<usize>,

}



// SearchEntry removed — SearchIndex stores Vec<usize> indices into files

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: u32,
}

#[derive(Debug, Clone)]
pub struct NormalizedPath {

    pub workspace_id: String,

    pub relative: String,

    pub absolute: String,

    pub r#ref: String,

}



#[derive(Debug, Serialize, Deserialize)]

struct WorkspacesConfig {

    workspaces: Vec<Workspace>,

    default_workspace_id: String,

}



impl AppState {

    pub fn new(data_root: PathBuf) -> Self {

        Self {

            data_root,

            workspaces: Arc::new(RwLock::new(Vec::new())),

            default_workspace_id: Arc::new(RwLock::new(DEFAULT_WORKSPACE_ID.to_string())),

            files: Arc::new(RwLock::new(Vec::new())),

            tree: Arc::new(RwLock::new(None)),

            search_index: Arc::new(RwLock::new(SearchIndex::default())),

            token_dict: Arc::new(TokenDictionary::new()),

        }

    }



    pub async fn init(&mut self) -> anyhow::Result<()> {

        self.data_root = resolve_data_root(&self.data_root);
        log::info!("[init] data_root resolved: {}", self.data_root.display());

        std::fs::create_dir_all(&self.data_root).ok();
        log::info!("[init] data_root dir created");

        let workspaces = self.load_workspaces().await;
        log::info!("[init] loaded {} workspaces", workspaces.len());

        {

            let mut ws = self.workspaces.write().await;

            *ws = workspaces;

        }

        {

            let default_root = default_workspace_root(&self.data_root).to_string_lossy().to_string();

            let mut changed = false;

            let mut ws = self.workspaces.write().await;

            for w in ws.iter_mut() {

                if w.id == DEFAULT_WORKSPACE_ID && w.root != default_root {

                    log::info!("[init] sync default workspace root: {} -> {}", w.root, default_root);

                    w.root = default_root.clone();

                    changed = true;

                }

            }

            drop(ws);

            if changed {

                let _ = self.save_workspaces().await;

            }

        }


        if self.workspaces.read().await.is_empty() {

            let root_path = default_workspace_root(&self.data_root);

            let default_ws = Workspace {

                id: DEFAULT_WORKSPACE_ID.to_string(),

                name: "默认工作区".to_string(),

                root: root_path.to_string_lossy().to_string(),

                visible: true,

                last_used: 0,

                md_only: false,

            };

            self.workspaces.write().await.push(default_ws);

            self.save_workspaces().await?;

        }



        log::info!("[init] calling refresh_cache()...");
        self.refresh_cache().await?;
        log::info!("[init] refresh_cache() completed");

        log::info!(

            "AppState initialized: {} workspaces, {} documents",

            self.workspaces.read().await.len(),

            self.files.read().await.len()

        );

        Ok(())

    }



    pub async fn refresh_cache(&self) -> anyhow::Result<()> {

        // 首屏只扫描 visible 的工作区（当前最多 2 个）。
        // 非 visible 工作区：
        //   - openDoc/global search 命中不到时，由 read_file() / scan_workspace_if_hidden_owner()
        //     懒扫描该工作区并把结果 extend 进 self.files + tree 重建；
        //   - show_workspace(true) 切到可见时，refresh_cache 已自然覆盖。
        let workspaces = self.workspaces.read().await.clone();
        let visible_ws_ids: std::collections::HashSet<String> = workspaces
            .iter()
            .filter(|w| w.visible)
            .map(|w| w.id.clone())
            .collect();

        let mut all_files = Vec::new();

        for ws in &workspaces {
            if !visible_ws_ids.contains(&ws.id) {
                continue;
            }
            let ws_files = scan_workspace(ws, &self.token_dict).await;
            all_files.extend(ws_files);
        }



        let search_indices: Vec<usize> = (0..all_files.len()).collect();
        let tree = build_tree(&all_files, &workspaces);



        {

            let mut files = self.files.write().await;

            *files = all_files;

        }

        {

            let mut idx = self.search_index.write().await;

            idx.entries = search_indices;

        }

        {

            let mut t = self.tree.write().await;

            *t = Some(tree);

        }



        Ok(())

    }



    async fn load_workspaces(&self) -> Vec<Workspace> {

        let config_path = self.workspaces_config_path();

        if let Ok(data) = std::fs::read_to_string(&config_path) {

            let data = data.strip_prefix('\u{feff}').unwrap_or(&data);

            if let Ok(config) = serde_json::from_str::<WorkspacesConfig>(data) {

                if !config.workspaces.is_empty() {

                    return config.workspaces;

                }

            }

        }

        default_workspaces(&self.data_root)

    }



    pub async fn save_workspaces(&self) -> anyhow::Result<()> {

        let config_path = self.workspaces_config_path();

        if let Some(parent) = config_path.parent() {

            std::fs::create_dir_all(parent).ok();

        }

        let workspaces = self.workspaces.read().await.clone();

        let default_id = self.default_workspace_id.read().await.clone();

        let config = WorkspacesConfig {

            workspaces,

            default_workspace_id: default_id,

        };

        let json = serde_json::to_string_pretty(&config)?;

        std::fs::write(&config_path, json)?;

        Ok(())

    }



    fn workspaces_config_path(&self) -> PathBuf {

        self.data_root.join("workspaces.json")

    }



    pub async fn get_workspaces(&self) -> Vec<Workspace> {

        self.workspaces.read().await.clone()

    }



    pub async fn get_default_workspace_id(&self) -> String {

        self.default_workspace_id.read().await.clone()

    }



    pub async fn set_default_workspace(&self, id: &str) -> anyhow::Result<()> {

        {

            let mut d = self.default_workspace_id.write().await;

            *d = id.to_string();

        }

        self.save_workspaces().await?;

        self.refresh_cache().await?;

        Ok(())

    }



    pub async fn add_workspace(&self, path: &str, name: &str) -> anyhow::Result<Workspace> {

        // Enforce workspace limit
        const MAX_WORKSPACES: usize = 50;
        let existing = self.workspaces.read().await.len();
        if existing >= MAX_WORKSPACES {
            anyhow::bail!("已达到最大工作区数量限制 ({})，请先删除部分工作区", MAX_WORKSPACES);
        }

        let canonical = std::fs::canonicalize(path)

            .map_err(|e| anyhow::anyhow!("Cannot access path: {}", e))?;

        let id = format!(

            "ws_{}",

            uuid::Uuid::new_v4().to_string().replace("-", "")[..8].to_string()

        );

        let ws_name = if name.is_empty() {

            canonical

                .file_name()

                .and_then(|n| n.to_str())

                .unwrap_or("New Workspace")

                .to_string()

        } else {

            name.to_string()

        };

        let ws = Workspace {

            id,

            name: ws_name,

            root: canonical.to_string_lossy().to_string(),

            visible: self.workspaces.read().await.is_empty(),

            last_used: 0,

            md_only: false,

        };

        self.workspaces.write().await.push(ws.clone());

        self.save_workspaces().await?;

        self.refresh_cache().await?;

        Ok(ws)

    }



    pub async fn remove_workspace(&self, id: &str) -> anyhow::Result<()> {

        if id == DEFAULT_WORKSPACE_ID {

            anyhow::bail!("Cannot delete default workspace");

        }

        self.workspaces.write().await.retain(|w| w.id != id);

        if self.default_workspace_id.read().await.as_str() == id {

            *self.default_workspace_id.write().await = DEFAULT_WORKSPACE_ID.to_string();

        }

        self.save_workspaces().await?;

        self.refresh_cache().await?;

        Ok(())

    }



    pub async fn rename_workspace(&self, id: &str, name: &str) -> anyhow::Result<()> {

        {

            let mut workspaces = self.workspaces.write().await;

            if let Some(ws) = workspaces.iter_mut().find(|w| w.id == id) {

                ws.name = name.chars().take(60).collect();

                ws.last_used = chrono::Utc::now().timestamp_millis() as u64;

            }

        }

        self.save_workspaces().await?;

        self.refresh_cache().await?;

        Ok(())

    }



        pub async fn set_md_only(&self, id: &str, md_only: bool) -> anyhow::Result<()> {
        {
            let mut workspaces = self.workspaces.write().await;
            if let Some(ws) = workspaces.iter_mut().find(|w| w.id == id) {
                ws.md_only = md_only;
                ws.last_used = chrono::Utc::now().timestamp_millis() as u64;
            }
        }
        self.save_workspaces().await?;
        self.refresh_cache().await?;
        Ok(())
    }

    pub async fn show_workspace(&self, id: &str, visible: bool) -> anyhow::Result<()> {

        {

            let mut workspaces = self.workspaces.write().await;

            if let Some(ws) = workspaces.iter_mut().find(|w| w.id == id) {

                ws.visible = visible;

                ws.last_used = chrono::Utc::now().timestamp_millis() as u64;

                if visible {

                    let visible_list: Vec<String> = workspaces

                        .iter()

                        .filter(|w| w.visible && w.id != id)

                        .map(|w| w.id.clone())

                        .collect();

                    for (i, vid) in visible_list.iter().enumerate() {

                        if i >= 1 {

                            if let Some(w) = workspaces.iter_mut().find(|w| w.id == *vid) {

                                w.visible = false;

                            }

                        }

                    }

                }

            }

        }

        self.save_workspaces().await?;

        self.refresh_cache().await?;

        Ok(())

    }

    /// 若 ref_path（如 lastOpenedDoc / recent doc / 搜索点击路径）归属于当前 hidden 的工作区，
    /// 懒扫描该工作区并把结果合并进 self.files + self.tree + search_index。
    /// 归属于 visible 工作区或无法识别时直接 Ok(())（空操作）。
    async fn scan_hidden_workspace_owning_path(&self, ref_path: &str) -> anyhow::Result<()> {
        // 从 ref_path 解析候选 workspace_id（复用 normalize_doc_path 的格式：ws_id:xxx 或 ws_id/xxx）
        let decoded = ref_path.replace('\\', "/");
        let candidate_ws_id: Option<String> = if let Some(idx) = decoded.find(':') {
            let prefix = &decoded[..idx];
            if !prefix.is_empty() && prefix.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                Some(prefix.to_string())
            } else { None }
        } else if let Some(idx) = decoded.find('/') {
            let prefix = &decoded[..idx];
            if prefix.starts_with("ws_")
                || (prefix.chars().all(|c| c.is_alphanumeric() || c == '_') && !prefix.is_empty())
            { Some(prefix.to_string()) } else { None }
        } else { None };

        let Some(ws_id) = candidate_ws_id else { return Ok(()); };

        // 查找目标 workspace（若不存在或已 visible，跳过）
        let target = {
            let wss = self.workspaces.read().await;
            match wss.iter().find(|w| w.id == ws_id) {
                Some(w) if !w.visible => w.clone(),
                _ => return Ok(()),
            }
        };

        // 快速互斥：如果该 hidden ws 已经出现在 files 中（另一个协程刚懒扫完），跳过
        {
            let f = self.files.read().await;
            if f.iter().any(|x| x.workspace_id == target.id) { return Ok(()); }
        }

        log::info!("[scan_hidden_ws] lazy-scan hidden workspace id={} root={}", target.id, target.root);
        let new_entries = scan_workspace(&target, &self.token_dict).await;
        if new_entries.is_empty() { return Ok(()); }

        // 合并进 self.files（仅追加当前 ws 没出现过的条目，按 path 去重）
        {
            let mut files = self.files.write().await;
            let existing_paths: std::collections::HashSet<String> =
                files.iter().map(|f| f.path.clone()).collect();
            for e in new_entries.into_iter() {
                if !existing_paths.contains(&e.path) { files.push(e); }
            }
            // 重建 search_index（保持 entries = 0..files.len()）
            let mut idx = self.search_index.write().await;
            idx.entries = (0..files.len()).collect();
        }

        // 重建 tree（包含所有 workspaces —— 即使 hidden 只对 search/read_file 有效，
        //  build_tree 会过滤掉 files 里没有的 ws 节点，所以 hidden ws 不出现在可见树上，符合预期）
        {
            let workspaces = self.workspaces.read().await.clone();
            let files = self.files.read().await.clone();
            let tree = build_tree(&files, &workspaces);
            let mut t = self.tree.write().await;
            *t = Some(tree);
        }
        Ok(())
    }

    pub async fn read_file(&self, path: &str) -> anyhow::Result<FileEntry> {
        let input_nfc = nfc(path);

        // Level 1: cache 精确匹配 (原始 ==) 或 NFC 归一后匹配
        // 解决 Mac NFD / Win NFC 路径字符串字面不相等但语义相同造成"搜得到但点不开"
        {
            let files = self.files.read().await;
            if let Some(entry) = files.iter().find(|f| {
                f.path == path || nfc(&f.path) == input_nfc
            }) {
                if entry.content.is_some() { return Ok(entry.clone()); }
                // content is None — fall through to disk read (lazy backfill)
            }
        }

        // Level 1.5: refresh_cache() 仅扫描 visible 工作区，若 path 归属于某 hidden 工作区，
        //           先懒扫描该工作区并合并进 files/tree，再回到正常路径继续匹配。
        //           典型场景：recent 打开过的文档 → 该 ws 后来被 hidden，但前端仍有 lastOpenedDoc
        if let Err(_e) = self.scan_hidden_workspace_owning_path(path).await {
            // ignore: lazy 扫描失败不阻塞正常 read_file（后续 normalize 直接走磁盘读兜底）
        }
        // 懒合并后再做一次 cache 命中（content 仍可能 None → 继续走磁盘回读）
        {
            let files = self.files.read().await;
            if let Some(entry) = files.iter().find(|f| {
                f.path == path || nfc(&f.path) == input_nfc
            }) {
                if entry.content.is_some() { return Ok(entry.clone()); }
            }
        }

        // Level 2: 按文件名弱匹配（3 级兜底，命中任何一级直接读取磁盘）
        //   a) basename NFC 精确相等 + 同 workspace（若能从 input 解析出 workspace_id）
        //   b) 去掉数字/版本后缀的 basename 相等（兼容江西电信 MR622-MK / MR622-MK-1）
        //   c) 同一个 workspace 内 basename 全局唯一命中（即使路径前缀全错）
        // 所有弱匹配命中后，重新 normalize 再读磁盘，避免把缓存里的陈旧内容返回。
        let input_basename = nfc_basename(&input_nfc);
        let input_ws = {
            let decoded = path.replace('\\', "/");
            if let Some(idx) = decoded.find(':') {
                let prefix = &decoded[..idx];
                if !prefix.is_empty() && prefix.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                    Some(prefix.to_string())
                } else { None }
            } else if let Some(idx) = decoded.find('/') {
                let prefix = &decoded[..idx];
                if prefix.starts_with("ws_") || (prefix.chars().all(|c| c.is_alphanumeric() || c == '_') && !prefix.is_empty()) {
                    Some(prefix.to_string())
                } else { None }
            } else { None }
        };

        let mut fallback_ref_path: Option<String> = None;
        {
            let files = self.files.read().await;
            // 2a) basename NFC + 同 workspace_id
            if !input_basename.is_empty() {
                let mut matched: Vec<String> = files.iter()
                    .filter(|f| nfc_basename(&f.path) == input_basename)
                    .filter(|f| input_ws.as_ref().map_or(true, |w| f.workspace_id == *w))
                    .map(|f| f.path.clone())
                    .collect();
                if matched.len() == 1 {
                    fallback_ref_path = Some(matched.swap_remove(0));
                }
            }
            // 2b) 去掉尾部数字 / 分隔符后缀后再比较（例如 MR622-MK.md vs MR622-MK-副本.md）
            if fallback_ref_path.is_none() && !input_basename.is_empty() {
                let trimmed_input = input_basename
                    .trim_end_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '_' || c == ' ')
                    .to_string();
                let mut candidates: Vec<String> = files.iter()
                    .filter(|f| {
                        let tb = nfc_basename(&f.path)
                            .trim_end_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '_' || c == ' ')
                            .to_string();
                        !tb.is_empty() && tb == trimmed_input
                    })
                    .filter(|f| input_ws.as_ref().map_or(true, |w| f.workspace_id == *w))
                    .map(|f| f.path.clone())
                    .collect();
                if candidates.len() == 1 {
                    fallback_ref_path = Some(candidates.swap_remove(0));
                }
            }
            // 2c) workspace 内 basename 全局唯一命中（允许 input 是缺路径前缀的裸文件名）
            if fallback_ref_path.is_none() && !input_basename.is_empty() {
                let mut by_basename: Vec<&FileEntry> = files.iter()
                    .filter(|f| nfc_basename(&f.path) == input_basename)
                    .collect();
                if by_basename.len() == 1 {
                    fallback_ref_path = Some(by_basename.swap_remove(0).path.clone());
                }
            }
        }

        // 归一化：优先用原始 path；弱匹配命中则用命中的 ref_path（来自 cache 的真实存在路径）
        let target_ref = fallback_ref_path.as_deref().unwrap_or(path);
        let normalized = match self.normalize_doc_path(target_ref) {
            Ok(n) => n,
            Err(e) => {
                let first_bytes_hex: String = path.as_bytes().iter().take(4)
                    .map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");
                log::error!(
                    "[read_file] normalize_doc_path failed | path={} | len={} | head=[{}] | err={}",
                    path, path.len(), first_bytes_hex, e
                );
                return Err(e);
            }
        };

        // 读磁盘：先读 bytes，再走智能编码解码；read_to_string UTF-8 失败不再直接 Err 404
        let bytes = match std::fs::read(&normalized.absolute) {
            Ok(b) => b,
            Err(e) => {
                log::error!(
                    "[read_file] fs::read IO 失败 | ref={} | abs={} | len(raw_path)={} | err={}",
                    normalized.r#ref, normalized.absolute, path.len(), e
                );
                return Err(anyhow::anyhow!("读取文件失败: {}", e));
            }
        };

        let (content, encoding_detected) = decode_bytes_smart(&bytes);
        // 编码识别失败（utf-8-lossy 且内容几乎全是 U+FFFD）时，仍然继续返回，上层 openDoc 会显示"空内容/编码异常"提示；
        // 这里打一条 error 日志方便用户通过日志直接定位编码未命中。
        let lossy_replacement_count = content.matches('\u{fffd}').count();
        if encoding_detected == "utf-8-lossy" && lossy_replacement_count > 0 {
            let first_bytes_hex: String = bytes.iter().take(4)
                .map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");
            log::error!(
                "[read_file] 编码兜底至 utf-8-lossy,替换字符={} | ref={} | abs={} | total_bytes={} | head=[{}]",
                lossy_replacement_count, normalized.r#ref, normalized.absolute, bytes.len(), first_bytes_hex
            );
        }

        // normalize_doc_path 算出的 workspace_id/relative 在弱匹配命中后可能和 cache 不一致，
        // 强制把归一后的 ref_path 用命中的 cache entry path（若有）对齐：保证前端拿到的 path 与搜索结果 path 同源，
        // 后续 save_file / refresh_cache 可以正确找同 entry 更新。
        let final_normalized = if let Some(cache_ref) = fallback_ref_path.as_ref() {
            let mut merged = normalized.clone();
            merged.r#ref = cache_ref.clone();
            merged
        } else {
            normalized.clone()
        };

        let mut entry = self.build_file_entry(&final_normalized, &content).await;
        // build_file_entry 里 encoding 字段默认写 utf-8；这里覆盖为我们真实识别出的编码，
        // 前端 openDoc 拿到后在状态栏可显示（state.currentEncoding = doc.encoding），便于排查编码命中问题。
        entry.encoding = encoding_detected;

        // Backfill cache: set content on the cached entry (lazy load)
        {
            let mut files = self.files.write().await;
            let target_nfc = nfc(&entry.path);
            if let Some(cache_entry) = files.iter_mut().find(|f| f.path == entry.path || nfc(&f.path) == target_nfc) {
                cache_entry.content = Some(content.clone());
            }
        }
        Ok(entry)
    }



    pub async fn save_file(&self, path: &str, content: &str, base_hash: Option<&str>) -> anyhow::Result<String> {

        let normalized = self.normalize_doc_path(path)?;

        // Issue 2: 保存前冲突检测——如果 base_hash 提供，读磁盘文件 hash 比对，
        // 不一致说明外部编辑器（如 Notepad）已修改该文件，拒绝保存防止覆盖丢失外部修改。
        if let Some(bh) = base_hash {
            if !bh.is_empty() {
                if let Ok(disk_bytes) = std::fs::read(&normalized.absolute) {
                    let disk_hash = format!("{:x}", sha2::Sha256::digest(&disk_bytes));
                    if disk_hash != bh {
                        // 磁盘文件 hash 与前端加载时的 base_hash 不一致 = 外部已修改
                        log::warn!(
                            "[save_file] CONFLICT | ref={} | abs={} | base_hash={} | disk_hash={}",
                            normalized.r#ref, normalized.absolute, bh, disk_hash
                        );
                        return Err(anyhow::anyhow!("__CONFLICT__:{}", disk_hash));
                    }
                }
                // 磁盘文件不存在时跳过冲突检测，正常走 create+write 流程
            }
        }

        if let Some(parent) = Path::new(&normalized.absolute).parent() {

            std::fs::create_dir_all(parent)?;

        }

        let tmp = format!("{}.tmp", normalized.absolute);

        std::fs::write(&tmp, content)?;

        std::fs::rename(&tmp, &normalized.absolute)?;



        let hash = format!("{:x}", sha2::Sha256::digest(content.as_bytes()));



        let mut files = self.files.write().await;

        let target_ref_nfc = nfc(&normalized.r#ref);
        if let Some(entry) = files.iter_mut().find(|f| {
            f.path == normalized.r#ref || nfc(&f.path) == target_ref_nfc
        }) {

            entry.content = Some(content.to_string());

            entry.content_sha256 = hash.clone();

            entry.plain = if normalized.relative.ends_with(".md") || normalized.relative.ends_with(".markdown") {
                strip_markdown(content)
            } else {
                content.to_string()
            };

            entry.modified = chrono::Utc::now().timestamp_millis() as u64;

        } else {

            drop(files);

            self.refresh_cache().await?;

        }



        Ok(hash)

    }



    /// Issue 2: 轻量级文件修改检查——返回磁盘文件当前 sha256 + modified 毫秒。
    /// 前端每 5s 轮询此端点，与 state.currentVersion（打开时的 contentSha256）比对，
    /// 不同则 Toast「文件已被外部修改，点击重新加载」。
    pub async fn check_file(&self, path: &str) -> anyhow::Result<(String, u64)> {
        let input_nfc = nfc(path);
        // 尝试 cache 命中拿到 absolute 路径（避免每次轮询都走 normalize_doc_path）
        {
            let files = self.files.read().await;
            if let Some(entry) = files.iter().find(|f| {
                f.path == path || nfc(&f.path) == input_nfc
            }) {
                let abs = entry.absolute.clone();
                drop(files);
                if let Ok(meta) = std::fs::metadata(&abs) {
                    let modified = meta.modified().ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    let bytes = std::fs::read(&abs)?;
                    let hash = format!("{:x}", sha2::Sha256::digest(&bytes));
                    return Ok((hash, modified));
                }
            }
        }
        // fallback: normalize 后读磁盘
        let normalized = self.normalize_doc_path(path)?;
        let bytes = std::fs::read(&normalized.absolute)?;
        let hash = format!("{:x}", sha2::Sha256::digest(&bytes));
        let modified = std::fs::metadata(&normalized.absolute).ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok((hash, modified))
    }



    /// Issue 2 补充: 外部修改 Toast「重新加载」需要磁盘最新内容，不能走 read_file L1 cache（内存中仍是旧 content）。
    /// 与 read_file 区别：跳过 L1 cache 直接命中返回，强制从磁盘重新读取 + decode；读完后若 cache 中已有对应 entry，
    /// 就地更新 content/content_sha256/encoding/plain/modified，保证下次 read_file 正常命中。
    pub async fn read_file_force(&self, path: &str) -> anyhow::Result<FileEntry> {
        let input_nfc = nfc(path);

        // ── Level 1 跳过: 不直接返回 cache entry ──
        // 但仍复用 cache 中的 basename/absolute 信息做弱匹配，沿用 read_file 同款 L2 3 级兜底：
        let input_basename = nfc_basename(&input_nfc);
        let input_ws = {
            let decoded = path.replace('\\', "/");
            if let Some(idx) = decoded.find(':') {
                let prefix = &decoded[..idx];
                if !prefix.is_empty() && prefix.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                    Some(prefix.to_string())
                } else { None }
            } else if let Some(idx) = decoded.find('/') {
                let prefix = &decoded[..idx];
                if prefix.starts_with("ws_") || (prefix.chars().all(|c| c.is_alphanumeric() || c == '_') && !prefix.is_empty()) {
                    Some(prefix.to_string())
                } else { None }
            } else { None }
        };

        let mut fallback_ref_path: Option<String> = None;
        {
            let files = self.files.read().await;
            if !input_basename.is_empty() {
                let mut matched: Vec<String> = files.iter()
                    .filter(|f| nfc_basename(&f.path) == input_basename)
                    .filter(|f| input_ws.as_ref().map_or(true, |w| f.workspace_id == *w))
                    .map(|f| f.path.clone())
                    .collect();
                if matched.len() == 1 {
                    fallback_ref_path = Some(matched.swap_remove(0));
                }
            }
            if fallback_ref_path.is_none() && !input_basename.is_empty() {
                let trimmed_input = input_basename
                    .trim_end_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '_' || c == ' ')
                    .to_string();
                let mut candidates: Vec<String> = files.iter()
                    .filter(|f| {
                        let tb = nfc_basename(&f.path)
                            .trim_end_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '_' || c == ' ')
                            .to_string();
                        !tb.is_empty() && tb == trimmed_input
                    })
                    .filter(|f| input_ws.as_ref().map_or(true, |w| f.workspace_id == *w))
                    .map(|f| f.path.clone())
                    .collect();
                if candidates.len() == 1 {
                    fallback_ref_path = Some(candidates.swap_remove(0));
                }
            }
            if fallback_ref_path.is_none() && !input_basename.is_empty() {
                let mut by_basename: Vec<&FileEntry> = files.iter()
                    .filter(|f| nfc_basename(&f.path) == input_basename)
                    .collect();
                if by_basename.len() == 1 {
                    fallback_ref_path = Some(by_basename.swap_remove(0).path.clone());
                }
            }
        }

        let target_ref = fallback_ref_path.as_deref().unwrap_or(path);
        let normalized = self.normalize_doc_path(target_ref)
            .map_err(|e| {
                let first_bytes_hex: String = path.as_bytes().iter().take(4)
                    .map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");
                log::error!(
                    "[read_file_force] normalize_doc_path failed | path={} | len={} | head=[{}] | err={}",
                    path, path.len(), first_bytes_hex, e
                );
                e
            })?;

        let bytes = std::fs::read(&normalized.absolute).map_err(|e| {
            log::error!(
                "[read_file_force] fs::read IO 失败 | ref={} | abs={} | len(raw_path)={} | err={}",
                normalized.r#ref, normalized.absolute, path.len(), e
            );
            anyhow::anyhow!("读取文件失败: {}", e)
        })?;

        let (content, encoding_detected) = decode_bytes_smart(&bytes);
        let lossy_replacement_count = content.matches('\u{fffd}').count();
        if encoding_detected == "utf-8-lossy" && lossy_replacement_count > 0 {
            let first_bytes_hex: String = bytes.iter().take(4)
                .map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");
            log::error!(
                "[read_file_force] 编码兜底至 utf-8-lossy,替换字符={} | ref={} | abs={} | total_bytes={} | head=[{}]",
                lossy_replacement_count, normalized.r#ref, normalized.absolute, bytes.len(), first_bytes_hex
            );
        }

        let final_normalized = if let Some(cache_ref) = fallback_ref_path.as_ref() {
            let mut merged = normalized.clone();
            merged.r#ref = cache_ref.clone();
            merged
        } else {
            normalized.clone()
        };

        let mut entry = self.build_file_entry(&final_normalized, &content).await;
        entry.encoding = encoding_detected.clone();

        // ── 刷新 cache entry（若存在）──
        {
            let mut files = self.files.write().await;
            let target_ref_nfc = nfc(&final_normalized.r#ref);
            if let Some(cache_entry) = files.iter_mut().find(|f| {
                f.path == final_normalized.r#ref || nfc(&f.path) == target_ref_nfc
            }) {
                cache_entry.content = Some(content.to_string());
                cache_entry.content_sha256 = entry.content_sha256.clone();
                cache_entry.encoding = encoding_detected;
                cache_entry.modified = chrono::Utc::now().timestamp_millis() as u64;
                cache_entry.plain = if final_normalized.relative.ends_with(".md") || final_normalized.relative.ends_with(".markdown") {
                    strip_markdown(&content)
                } else {
                    content.to_string()
                };
            }
        }

        Ok(entry)
    }



    pub async fn delete_file(&self, path: &str) -> anyhow::Result<()> {

        let normalized = self.normalize_doc_path(path)?;

        let abs = Path::new(&normalized.absolute);

        if !abs.exists() {

            anyhow::bail!("File or directory not found");

        }

        if abs.is_dir() {

            std::fs::remove_dir_all(abs)?;

        } else {

            std::fs::remove_file(abs)?;

        }

        self.refresh_cache().await?;

        Ok(())

    }



    pub async fn create_folder(&self, parent: &str, name: &str) -> anyhow::Result<String> {

        let sanitized = sanitize_name(name);

        if sanitized.is_empty() {

            anyhow::bail!("Folder name cannot be empty");

        }

        let parent_path = self.normalize_doc_path(parent)?;

        let relative = format!("{}/{}", parent_path.relative, sanitized);

        let normalized = self.normalize_doc_path(&relative)?;

        let abs = Path::new(&normalized.absolute);

        if abs.exists() {

            anyhow::bail!("Folder already exists");

        }

        std::fs::create_dir(abs)?;

        self.refresh_cache().await?;

        Ok(normalized.r#ref)

    }



    pub async fn create_doc(&self, parent: &str, name: &str) -> anyhow::Result<(String, String)> {

        let sanitized = sanitize_name(name).trim_end_matches(".md").to_string();

        if sanitized.is_empty() {

            anyhow::bail!("Document name cannot be empty");

        }

        let file_name = format!("{}.md", sanitized);

        let parent_path = self.normalize_doc_path(parent)?;

        let relative = format!("{}/{}", parent_path.relative, file_name);

        let normalized = self.normalize_doc_path(&relative)?;

        let abs = Path::new(&normalized.absolute);

        if abs.exists() {

            anyhow::bail!("Document already exists");

        }

        if let Some(p) = abs.parent() {

            std::fs::create_dir_all(p)?;

        }

        let content = document_template(&sanitized);

        std::fs::write(&abs, &content)?;

        self.refresh_cache().await?;

        let hash = format!("{:x}", sha2::Sha256::digest(content.as_bytes()));

        Ok((normalized.r#ref, hash))

    }



    pub async fn get_tree(&self) -> TreeNode {

        self.tree

            .read()

            .await

            .clone()

            .unwrap_or_else(|| TreeNode {

                name: "/".to_string(),

                path: "".to_string(),

                node_type: "folder".to_string(),

                workspace_id: None,

                root: None,

                modified: None,

                children: Vec::new(),

            })

    }



    pub async fn search(&self, query: &str) -> Vec<SearchResult> {

        fn align_boundary(s: &str, byte_pos: usize, forward: bool) -> usize {
            let clamped = byte_pos.min(s.len());
            if s.is_char_boundary(clamped) { return clamped; }
            if forward {
                (clamped..=s.len()).find(|&i| s.is_char_boundary(i)).unwrap_or(s.len())
            } else {
                (0..=clamped).rev().find(|&i| s.is_char_boundary(i)).unwrap_or(0)
            }
        }

        // 解析查询：提取引号内精确短语 + 其余按空格分词
        let query_trimmed = query.trim();
        if query_trimmed.is_empty() { return Vec::new(); }

        let mut phrases: Vec<String> = Vec::new();
        let mut remaining = query_trimmed.to_string();
        // 提取 "..." 短语
        while let Some(start) = remaining.find('"') {
            if let Some(end) = remaining[start + 1..].find('"') {
                let phrase = remaining[start + 1..start + 1 + end].to_lowercase();
                if !phrase.is_empty() {
                    phrases.push(phrase);
                }
                remaining = format!("{} {}", &remaining[..start], &remaining[start + 1 + end + 1..]);
            } else {
                break;
            }
        }
        let mut tokens: Vec<String> = remaining
            .split_whitespace()
            .map(|s| s.to_lowercase())
            .filter(|s| s.len() >= 1)
            .collect();
        // 去重
        tokens.sort();
        tokens.dedup();

        let index = self.search_index.read().await;
        let files = self.files.read().await;

        let mut results: Vec<SearchResult> = index
            .entries
            .iter()
            .filter_map(|&idx| {
                let entry = &files[idx];
                let title_lower = entry.title.to_lowercase();
                let plain_lower = entry.plain.to_lowercase();

                // 精确短语必须全部匹配
                let phrases_ok = phrases.iter().all(|p| title_lower.contains(p) || plain_lower.contains(p));
                if !phrases_ok && !phrases.is_empty() { return None; }

                // 分词：全部匹配才算通过（AND 逻辑）
                let mut all_match = tokens.is_empty() || phrases.is_empty();
                if !tokens.is_empty() && !phrases.is_empty() {
                    all_match = phrases_ok;
                } else if !tokens.is_empty() {
                    all_match = tokens.iter().all(|t| title_lower.contains(t) || plain_lower.contains(t));
                }
                if !all_match { return None; }

                // 评分：title 命中 +50/个关键词，content 命中 +10/个，精确短语 +30/个
                let mut score: u32 = 0;
                for t in &tokens {
                    if title_lower.contains(t) { score += 50; }
                    if plain_lower.contains(t) { score += 10; }
                }
                for p in &phrases {
                    if title_lower.contains(p) { score += 80; }
                    if plain_lower.contains(p) { score += 30; }
                }
                if tokens.is_empty() && phrases.is_empty() {
                    // 单关键词 fallback
                    if title_lower.contains(&query_trimmed.to_lowercase()) { score = 100; }
                    else if plain_lower.contains(&query_trimmed.to_lowercase()) { score = 50; }
                }

                // 找 snippet：优先 title 匹配，否则找第一个匹配关键词的位置
                let snippet = if tokens.iter().any(|t| title_lower.contains(t)) || phrases.iter().any(|p| title_lower.contains(p)) {
                    entry.title.clone()
                } else {
                    let first_pos = tokens.iter()
                        .filter_map(|t| plain_lower.find(t))
                        .chain(phrases.iter().filter_map(|p| plain_lower.find(p)))
                        .min()
                        .unwrap_or(0);
                    let raw_start = first_pos.saturating_sub(40);
                    let raw_end = (first_pos + query_trimmed.len() + 60).min(entry.plain.len());
                    let start = align_boundary(&entry.plain, raw_start, true);
                    let end = align_boundary(&entry.plain, raw_end, false);
                    if start >= end {
                        String::new()
                    } else {
                        let context = &entry.plain[start..end];
                        if start > 0 {
                            format!("...{}", context)
                        } else {
                            context.to_string()
                        }
                    }
                };

                Some(SearchResult {
                    path: entry.path.clone(),
                    title: entry.title.clone(),
                    snippet,
                    score,
                })
            })
            .collect();

        // 按 score 降序排序
        results.sort_by(|a, b| b.score.cmp(&a.score));
        results

    }



    pub async fn get_files(&self) -> Vec<FileEntry> {

        self.files.read().await.clone()

    }



    pub async fn get_workspaces_sorted(&self) -> Vec<Workspace> {

        let mut workspaces = self.workspaces.read().await.clone();

        workspaces.sort_by(|a, b| b.last_used.cmp(&a.last_used));

        workspaces

    }



    pub fn normalize_doc_path(&self, input: &str) -> anyhow::Result<NormalizedPath> {

        let decoded = input.replace('\\', "/");

        let (workspace_id, relative) = {
            // 1) Try ":" separator first (canonical form "ws_id:relative/path")
            if let Some(idx) = decoded.find(':') {
                let prefix = &decoded[..idx];
                if !prefix.is_empty() && prefix.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                    (prefix.to_string(), decoded[idx + 1..].to_string())
                } else {
                    (DEFAULT_WORKSPACE_ID.to_string(), decoded.to_string())
                }
            }
            // 2) Fallback: "/" separator (e.g. "ws_6c24c9ac/pon/xxx.md")
            //    Only treat first segment as workspace_id if it looks like a ws_id
            else if let Some(idx) = decoded.find('/') {
                let prefix = &decoded[..idx];
                // Heuristic: starts with "ws_" OR matches a known workspace id
                let looks_like_ws = prefix.starts_with("ws_")
                    || prefix.chars().all(|c| c.is_alphanumeric() || c == '_');
                if !prefix.is_empty() && looks_like_ws {
                    (prefix.to_string(), decoded[idx + 1..].to_string())
                } else {
                    (DEFAULT_WORKSPACE_ID.to_string(), decoded)
                }
            } else {
                // No separator at all: treat as default workspace
                (DEFAULT_WORKSPACE_ID.to_string(), decoded)
            }
        };

        let relative = relative.trim_start_matches('/').to_string();



        let workspaces = match self.workspaces.try_read() {

            Ok(guard) => Some(guard),

            Err(_) => None,

        };



        let root = if let Some(ws) = workspaces.as_ref().and_then(|wss| {

            wss.iter().find(|w| w.id == workspace_id)

        }) {

            ws.root.clone()

        } else {

            self.data_root.to_string_lossy().to_string()

        };



        let absolute = Path::new(&root).join(&relative);

        let abs_str = if absolute.exists() {

            std::fs::canonicalize(&absolute)

                .map(|p| p.to_string_lossy().to_string())

                .unwrap_or_else(|_| absolute.to_string_lossy().to_string())

        } else {

            absolute.to_string_lossy().to_string()

        };



        let ref_path = if relative.is_empty() {

            workspace_id.clone()

        } else {

            format!("{}/{}", workspace_id, relative)

        };



        Ok(NormalizedPath {

            workspace_id,

            relative,

            absolute: abs_str,

            r#ref: ref_path,

        })

    }



    async fn build_file_entry(&self, normalized: &NormalizedPath, content: &str) -> FileEntry {

        let metadata = std::fs::metadata(&normalized.absolute).ok();

        let title = extract_title(content, normalized.relative.as_str());

        let plain = strip_markdown(content);

        let hash = format!("{:x}", sha2::Sha256::digest(content.as_bytes()));

        let tags: Vec<u32> = extract_tags(content).iter().map(|t| self.token_dict.intern(t)).collect();



        let workspace_name = self

            .workspaces

            .read()

            .await

            .iter()

            .find(|w| w.id == normalized.workspace_id)

            .map(|w| w.name.clone())

            .unwrap_or_default();



        FileEntry {

            path: normalized.r#ref.clone(),

            absolute: normalized.absolute.clone(),

            title,

            workspace_id: normalized.workspace_id.clone(),

            workspace_name,

            content: Some(content.to_string()),

            content_sha256: hash,

            plain,

            tags,

            terms: Vec::new(),

            created: metadata

                .as_ref()

                .and_then(|m| m.created().ok())

                .map(|t| {

                    t.duration_since(std::time::UNIX_EPOCH)

                        .unwrap_or_default()

                        .as_millis() as u64

                })

                .unwrap_or(0),

            modified: metadata

                .and_then(|m| m.modified().ok())

                .map(|t| {

                    t.duration_since(std::time::UNIX_EPOCH)

                        .unwrap_or_default()

                        .as_millis() as u64

                })

                .unwrap_or(0),

            encoding: "utf-8".to_string(),

        }

    }

    /// Move a file or folder to a target folder
    pub async fn move_entry(&self, source: &str, target_folder: &str) -> anyhow::Result<(String, bool)> {
        let src = self.normalize_doc_path(source)?;
        let tgt = self.normalize_doc_path(target_folder)?;

        let src_abs = Path::new(&src.absolute);
        let tgt_abs = Path::new(&tgt.absolute);

        if !src_abs.exists() {
            anyhow::bail!("Source not found");
        }
        if !tgt_abs.exists() || !tgt_abs.is_dir() {
            anyhow::bail!("Target folder not found");
        }

        let is_dir = src_abs.is_dir();
        if !is_dir && !src.relative.ends_with(".md") {
            anyhow::bail!("Only .md files can be moved");
        }

        // Prevent moving folder into itself
        if is_dir {
            let src_root = format!("{}{}", src.absolute, std::path::MAIN_SEPARATOR);
            let tgt_root = format!("{}{}", tgt.absolute, std::path::MAIN_SEPARATOR);
            if tgt_root.starts_with(&src_root) {
                anyhow::bail!("Folder cannot be moved into itself");
            }
        }

        let dest_name = src_relative_name(&src.relative);
        let dest_relative = format!("{}/{}", tgt.relative, dest_name);
        let dest = self.normalize_doc_path(&dest_relative)?;
        let dest_abs = Path::new(&dest.absolute);

        if src.absolute == dest.absolute {
            return Ok((src.r#ref, false));
        }
        if dest_abs.exists() {
            anyhow::bail!("Destination already exists");
        }

        if src.workspace_id == tgt.workspace_id {
            std::fs::rename(&src.absolute, &dest.absolute)?;
        } else {
            // Cross-workspace: copy then delete
            copy_dir_all(&src.absolute, &dest.absolute)?;
            if is_dir {
                std::fs::remove_dir_all(&src.absolute)?;
            } else {
                std::fs::remove_file(&src.absolute)?;
            }
        }

        self.refresh_cache().await?;
        Ok((dest.r#ref, is_dir))
    }


    /// Copy a file or folder to a target folder
    pub async fn copy_entry(&self, source: &str, target_folder: &str) -> anyhow::Result<String> {
        let src = self.normalize_doc_path(source)?;
        let tgt = self.normalize_doc_path(target_folder)?;

        let src_abs = Path::new(&src.absolute);
        let tgt_abs = Path::new(&tgt.absolute);

        if !src_abs.exists() {
            anyhow::bail!("Source not found");
        }
        if !tgt_abs.exists() || !tgt_abs.is_dir() {
            anyhow::bail!("Target folder not found");
        }

        let dest_name = src_relative_name(&src.relative);
        let dest_relative = format!("{}/{}", tgt.relative, dest_name);
        let dest = self.normalize_doc_path(&dest_relative)?;
        let dest_abs = Path::new(&dest.absolute);

        if dest_abs.exists() {
            anyhow::bail!("Destination already exists");
        }

        copy_dir_all(&src.absolute, &dest.absolute)?;
        self.refresh_cache().await?;
        Ok(dest.r#ref)
    }


    /// Rename a file or folder
    pub async fn rename_entry(&self, path: &str, new_name: &str) -> anyhow::Result<String> {
        let src = self.normalize_doc_path(path)?;
        let src_abs = Path::new(&src.absolute);

        if !src_abs.exists() {
            anyhow::bail!("Source not found");
        }
        if src.relative.is_empty() {
            anyhow::bail!("Workspace root cannot be renamed");
        }

        let is_dir = src_abs.is_dir();
        let mut safe_name = new_name.to_string();
        if !is_dir && !safe_name.ends_with(".md") {
            safe_name = format!("{}.md", safe_name);
        }
        safe_name = sanitize_name(&safe_name);
        if safe_name.is_empty() || safe_name == "." || safe_name == ".." {
            anyhow::bail!("Invalid name");
        }


        let parent_dir = src_abs.parent().unwrap_or_else(|| Path::new("."));
        let dest_abs = parent_dir.join(&safe_name);

        if dest_abs == src_abs {
            return Ok(src.r#ref);
        }
        if dest_abs.exists() {
            anyhow::bail!("Target already exists");
        }

        std::fs::rename(&src.absolute, &dest_abs)?;

        let parent_rel = src.relative.rsplit_once("/").map(|(p, _)| p).unwrap_or("");
        let new_relative = if parent_rel.is_empty() {
            safe_name
        } else {
            format!("{}/{}", parent_rel, safe_name)
        };
        let new_ref = format!("{}:/{}", src.workspace_id, new_relative);

        self.refresh_cache().await?;
        Ok(new_ref)
    }


    /// Get frontmatter keys and values from a markdown file
    pub async fn get_frontmatter(&self, path: &str) -> anyhow::Result<serde_json::Value> {
        let doc = self.read_file(path).await?;
        let content = doc.content.as_deref().unwrap_or("");
        let (_, after) = extract_frontmatter_block(content);
        let map = normalize_frontmatter(after);
        serde_json::to_value(map).map_err(|e| anyhow::anyhow!(e))
    }

    /// Get a preview of frontmatter with optional metadata applied
    pub async fn preview_frontmatter(&self, path: &str, metadata: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let doc = self.read_file(path).await?;
        let content = doc.content.as_deref().unwrap_or("");
        let (fm, _) = extract_frontmatter_block(content);
        let mut map = normalize_frontmatter(fm);

        // Apply metadata overrides
        if let Some(obj) = metadata.as_object() {
            for (key, val) in obj {
                match val {
                    serde_json::Value::String(s) => { map.insert(key.clone(), s.clone()); }
                    serde_json::Value::Number(n) => { map.insert(key.clone(), n.to_string()); }
                    serde_json::Value::Bool(b) => { map.insert(key.clone(), b.to_string()); }
                    serde_json::Value::Null => { map.remove(key); }
                    _ => { map.insert(key.clone(), val.to_string()); }
                }
            }
        }

        serde_json::to_value(map).map_err(|e| anyhow::anyhow!(e))
    }

    /// Replace frontmatter in a markdown file with new values
    pub async fn apply_frontmatter(&self, path: &str, metadata: &serde_json::Value, base_hash: &str) -> anyhow::Result<serde_json::Value> {
        let doc = self.read_file(path).await?;

        // Verify base_hash matches
        if !base_hash.is_empty() && doc.content_sha256 != base_hash {
            anyhow::bail!("Content hash mismatch, file may have been modified");
        }

        let content = doc.content.as_deref().unwrap_or("");
        let (_, body) = extract_frontmatter_block(content);
        let mut lines: Vec<String> = Vec::new();
        lines.push("---".to_string());
        if let Some(obj) = metadata.as_object() {
            for (key, val) in obj {
                let line = match val {
                    serde_json::Value::String(s) => format!("{}: {}", key, s),
                    serde_json::Value::Number(n) => format!("{}: {}", key, n),
                    serde_json::Value::Bool(b) => format!("{}: {}", key, b),
                    serde_json::Value::Array(arr) => {
                        let items: Vec<String> = arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
                        format!("{}: {}", key, items.join(", "))
                    }
                    _ => format!("{}: {}", key, val),
                };
                lines.push(line);
            }
        }
        lines.push("---".to_string());
        lines.push("".to_string());
        let mut new_content = lines.join("\n");
        new_content.push_str(body);
        let hash = self.save_file(path, &new_content, None).await?;
        Ok(serde_json::json!({
            "ok": true,
            "path": path,
            "contentSha256": hash,
        }))
    }


    /// Health check with system info
    pub async fn health_check(&self) -> serde_json::Value {
        let workspaces = match self.workspaces.try_read() {
            Ok(ws) => ws.len(),
            Err(_) => 0,
        };
        let cache_entries = match self.files.try_read() {
            Ok(c) => c.len(),
            Err(_) => 0,
        };
        let data_root = self.data_root.to_string_lossy().to_string();
        let version = env!("CARGO_PKG_VERSION").to_string();
        serde_json::json!({
            "status": "ok",
            "version": version,
            "workspaces": workspaces,
            "cache_entries": cache_entries,
            "data_root": data_root,
            "timestamp_ms": chrono::Utc::now().timestamp_millis(),
        })
    }
}


/// Extract basename (file or folder name) from a relative path
fn src_relative_name(relative: &str) -> String {
    let name = Path::new(relative).file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.is_empty() {
        Path::new(relative).file_stem().and_then(|n| n.to_str()).unwrap_or("").to_string()
    } else {
        name.to_string()
    }
}

/// Recursively copy a file or directory
fn copy_dir_all(src: &str, dst: &str) -> anyhow::Result<()> {
    let src_path = Path::new(src);
    let dst_path = Path::new(dst);
    if src_path.is_dir() {
        std::fs::create_dir_all(dst_path)?;
        for entry in walkdir::WalkDir::new(src_path).min_depth(1) {
            let entry = entry?;
            let rel = entry.path().strip_prefix(src_path)?;
            let target = dst_path.join(rel);
            if entry.file_type().is_dir() {
                std::fs::create_dir_all(&target)?;
            } else {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(entry.path(), &target)?;
            }
        }
    } else {
        if let Some(parent) = dst_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src_path, dst_path)?;
    }
    Ok(())
}


/// Extract YAML frontmatter block from markdown content.
/// Returns (frontmatter_body, remaining_content).
fn extract_frontmatter_block(content: &str) -> (&str, &str) {
    let bytes = content.as_bytes();
    if bytes.len() < 8 {
        return ("", content);
    }
    // Check for opening ---
    if !bytes.starts_with(b"---") {
        return ("", content);
    }
    // Find closing ---
    let after_open = &content[3..];
    let close_idx = after_open.find("\n---").or_else(|| after_open.find("---"));
    match close_idx {
        Some(idx) => {
            let fm = after_open[..idx].trim();
            let rest_start = idx + 3;
            let rest = after_open[rest_start..].trim_start_matches("\n").trim_start_matches("\r").trim_start_matches("\n");
            (fm, rest)
        }
        None => ("", content)
    }
}

/// Parse frontmatter body into a simple map of key -> string
fn normalize_frontmatter(fm_body: &str) -> std::collections::BTreeMap<String, String> {
    let mut map = std::collections::BTreeMap::new();
    for line in fm_body.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with("#") {
            continue;
        }
        if let Some(colon) = l.find(":") {
            let key = l[..colon].trim().trim_matches(|c| c == '\'' || c == '"');
            let val = l[colon+1..].trim().trim_matches(|c| c == '\'' || c == '"');
            if !key.is_empty() {
                map.insert(key.to_string(), val.to_string());
            }
        }
    }
    map
}

/// Build a small summary (title, date, tags) from markdown content
fn frontmatter_summary(content: &str) -> std::collections::BTreeMap<String, String> {
    let (fm, _) = extract_frontmatter_block(content);
    let map = normalize_frontmatter(fm);
    let mut summary = std::collections::BTreeMap::new();
    for key in ["title", "date", "tags"] {
        if let Some(v) = map.get(key) {
            summary.insert(key.to_string(), v.clone());
        }
    }
    summary
}







// ========== 辅助函数 ==========



fn resolve_data_root(default: &Path) -> PathBuf {

    if let Ok(root) = std::env::var("MYTEMPLE_DATA_ROOT") {

        let p = PathBuf::from(root);

        if p.is_dir() || std::fs::create_dir_all(&p).is_ok() {

            return p;

        }

    }

    if let Ok(root) = std::env::var("APPDATA") {

        let p = PathBuf::from(root).join("MyTemple Knowledge");

        if std::fs::create_dir_all(&p).is_ok() {

            return p;

        }

    }

    default.to_path_buf()

}



fn dirs_home() -> Option<PathBuf> {

    std::env::var("USERPROFILE")

        .or_else(|_| std::env::var("HOME"))

        .or_else(|_| std::env::var("USERDIR"))

        .ok()

        .map(PathBuf::from)

}

fn default_workspace_root(data_root: &Path) -> PathBuf {

    if let Ok(root) = std::env::var("MYTEMPLE_DEFAULT_WS_ROOT") {

        let p = PathBuf::from(root);

        let _ = std::fs::create_dir_all(&p);

        return p;

    }

    if let Ok(exe) = std::env::current_exe() {

        if let Some(parent) = exe.parent() {

            let dos_dir = parent.join("dos");

            if std::fs::create_dir_all(&dos_dir).is_ok() {

                return dos_dir;

            }

        }

    }

    let fallback = dirs_home().unwrap_or_else(|| data_root.to_path_buf());

    let dos_in_home = fallback.join("dos");

    let _ = std::fs::create_dir_all(&dos_in_home);

    dos_in_home

}



fn default_workspaces(data_root: &Path) -> Vec<Workspace> {

    let root_path = default_workspace_root(data_root);

    vec![Workspace {

        id: DEFAULT_WORKSPACE_ID.to_string(),

        name: "默认工作区".to_string(),

        root: root_path.to_string_lossy().to_string(),

        visible: true,

        last_used: 0,

        md_only: false,

    }]

}



fn is_binary_ext(ext: &str) -> bool {
    matches!(ext,
        "exe" | "dll" | "so" | "dylib" | "bin" | "obj" | "lib" | "a" | "o" |
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "ico" | "icns" | "tiff" | "webp" | "svgz" |
        "mp3" | "mp4" | "avi" | "mov" | "wmv" | "flv" | "mkv" | "wav" | "flac" | "ogg" | "webm" |
        "zip" | "gz" | "tar" | "rar" | "7z" | "bz2" | "xz" | "jar" | "war" | "cab" |
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" |
        "db" | "sqlite" | "sqlite3" | "mdb" | "lock" |
        "ttf" | "otf" | "woff" | "woff2" | "eot" |
        // 问题3: 移除 "key" — CRT 串口工具按键映射文件是文本格式，应被扫描和读取
        "p12" | "pfx" | "pem" | "class" | "pyc" | "pyo" | "wasm"
    )
}

async fn scan_workspace(ws: &Workspace, td: &TokenDictionary) -> Vec<FileEntry> {

    let root = Path::new(&ws.root);
    log::info!("[scan_workspace] scanning {} (id={}, md_only={})", ws.root, ws.id, ws.md_only);

    if !root.is_dir() {
        log::warn!("[scan_workspace] root not a dir: {}", ws.root);
        return Vec::new();
    }



    let mut entries = Vec::new();

    let mut seen = std::collections::HashSet::new();



    for entry in WalkDir::new(root)

        .max_depth(20)

        .follow_links(false)

        .into_iter()

        .filter_map(|e| e.ok())

    {

        if !entry.file_type().is_file() {

            continue;

        }

        let path = entry.path();

        let ext = path

            .extension()

            .and_then(|e| e.to_str())

            .unwrap_or("")

            .to_lowercase();

        if ws.md_only {
            if ext != "md" && ext != "markdown" {
                continue;
            }
        } else {
            // 非 md_only 模式：跳过已知二进制后缀和超大文件
            if is_binary_ext(&ext) {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.len() > 10_000_000 {
                    continue;
                }
            }
        }

        if seen.contains(path) {

            continue;

        }

        seen.insert(path.to_path_buf());



        let content = {
            // scan_workspace 也统一走智能解码，保证 GBK/BOM/UTF16LE 的 md 至少能进入 files cache，
            // 使得全局搜索可以命中（否则 UTF-8 失败就 continue，用户搜不到江西电信的 md）。
            match std::fs::read(path) {
                Ok(bytes) => {
                    let (decoded, _enc) = decode_bytes_smart(&bytes);
                    decoded
                }
                Err(_) => continue,
            }
        };



        let relative = path.strip_prefix(root).unwrap_or(path);

        let rel_str_raw = relative.to_string_lossy().replace('\\', "/");
        // 扫描入库的路径先做 NFC，与 openDoc -> read_file 输入端的 nfc() 保持同源，
        // 消除 Mac NFD 中文路径入库后、Win 端打开时字符串字面值不相等的问题。
        let rel_str = nfc(&rel_str_raw);

        let ref_path = format!("{}/{}", ws.id, rel_str);

        let title = extract_title(&content, rel_str.as_str());

        let is_md = ext == "md" || ext == "markdown";
        let plain = if is_md { strip_markdown(&content) } else { content.clone() };

        let hash = format!("{:x}", sha2::Sha256::digest(content.as_bytes()));

        let tags: Vec<u32> = extract_tags(&content).iter().map(|t| td.intern(t)).collect();



        let metadata = std::fs::metadata(path).ok();

        let created = metadata

            .as_ref()

            .and_then(|m| m.created().ok())

            .map(|t| {

                t.duration_since(std::time::UNIX_EPOCH)

                    .unwrap_or_default()

                    .as_millis() as u64

            })

            .unwrap_or(0);

        let modified = metadata

            .and_then(|m| m.modified().ok())

            .map(|t| {

                t.duration_since(std::time::UNIX_EPOCH)

                    .unwrap_or_default()

                    .as_millis() as u64

            })

            .unwrap_or(0);



        entries.push(FileEntry {

            path: ref_path,

            absolute: path.to_string_lossy().to_string(),

            title,

            workspace_id: ws.id.clone(),

            workspace_name: ws.name.clone(),

            content: None,

            content_sha256: hash,

            plain,

            tags,

            terms: Vec::new(),

            created,

            modified,

            encoding: "utf-8".to_string(),

        });

    }

    log::info!("[scan_workspace] done {} ({} files)", ws.root, entries.len());
    entries

}



fn build_tree(files: &[FileEntry], workspaces: &[Workspace]) -> TreeNode {

    let mut root = TreeNode {

        name: "/".to_string(),

        path: "".to_string(),

        node_type: "folder".to_string(),

        workspace_id: None,

        root: None,

        modified: None,

        children: Vec::new(),

    };



    for ws in workspaces {

        let mut ws_node = TreeNode {

            name: ws.name.clone(),

            path: ws.id.clone(),

            node_type: "workspace".to_string(),

            workspace_id: Some(ws.id.clone()),

            root: Some(ws.root.clone()),

            modified: None,

            children: Vec::new(),

        };



        for file in files {

            let parts: Vec<&str> = file.path.split('/').collect();

            if parts.len() < 2 {

                continue;

            }

            if parts[0] != ws.id {

                continue;

            }

            let rel_parts = &parts[1..];

            insert_into_tree(&mut ws_node, rel_parts, file);

        }



        root.children.push(ws_node);

    }



    sort_tree(&mut root);

    root

}



fn insert_into_tree(parent: &mut TreeNode, parts: &[&str], file: &FileEntry) {

    if parts.is_empty() {

        return;

    }

    if parts.len() == 1 {

        parent.children.push(TreeNode {

            name: parts[0].to_string(),

            path: file.path.clone(),

            node_type: "file".to_string(),

            workspace_id: None,

            root: None,

            modified: Some(file.modified),

            children: Vec::new(),

        });

        return;

    }



    let name = parts[0];

    let remaining = &parts[1..];



    let child = parent

        .children

        .iter_mut()

        .find(|c| c.name == name && c.node_type == "folder");

    match child {

        Some(node) => {

            insert_into_tree(node, remaining, file);

        }

        None => {

            let mut new_node = TreeNode {

                name: name.to_string(),

                path: if parent.path.is_empty() {

                    name.to_string()

                } else {

                    format!("{}/{}", parent.path, name)

                },

                node_type: "folder".to_string(),

                workspace_id: None,

                root: None,

                modified: None,

                children: Vec::new(),

            };

            insert_into_tree(&mut new_node, remaining, file);

            parent.children.push(new_node);

        }

    }

}



fn sort_tree(node: &mut TreeNode) {

    node.children.sort_by(|a, b| match (a.node_type.as_str(), b.node_type.as_str()) {

        ("folder", "file") => std::cmp::Ordering::Less,

        ("file", "folder") => std::cmp::Ordering::Greater,

        ("file", "file") => {
            // 文件按修改时间倒序（最新在前）
            let am = a.modified.unwrap_or(0);
            let bm = b.modified.unwrap_or(0);
            bm.cmp(&am)
        }

        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),

    });

    for child in node.children.iter_mut() {

        sort_tree(child);

    }

}



fn extract_title(content: &str, fallback: &str) -> String {

    for line in content.lines() {

        let trimmed = line.trim();

        if trimmed.starts_with("# ") {

            return trimmed[2..].trim().to_string();

        }

    }

    let name = Path::new(fallback)

        .file_stem()

        .and_then(|s| s.to_str())

        .unwrap_or(fallback);

    if name.is_empty() {

        fallback.to_string()

    } else {

        name.to_string()

    }

}



fn strip_markdown(content: &str) -> String {

    let mut result = content.to_string();

    if result.starts_with("---") {

        if let Some(end) = result[3..].find("\n---") {

            result = result[end + 4..].to_string();

        }

    }

    if let Ok(re) = regex::Regex::new(r"```[\s\S]*?```") {

        result = re.replace_all(&result, "").to_string();

    }

    if let Ok(re) = regex::Regex::new(r"`[^`]+`") {

        result = re.replace_all(&result, "").to_string();

    }

    if let Ok(re) = regex::Regex::new(r"[#>*_\[\]()!-]") {

        result = re.replace_all(&result, " ").to_string();

    }

    if let Ok(re) = regex::Regex::new(r"\s+") {

        result = re.replace_all(&result, " ").trim().to_string();

    }

    result

}



fn extract_tags(content: &str) -> Vec<String> {

    if let Ok(re) = regex::Regex::new(r"(?:^|\s)#([\p{L}\p{N}_-]+)") {

        return re

            .captures_iter(content)

            .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))

            .filter(|t| !t.is_empty() && t.len() <= 30)

            .collect();

    }

    Vec::new()

}



fn sanitize_name(name: &str) -> String {

    name.chars()

        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))

        .collect::<String>()

        .trim()

        .to_string()

}



fn document_template(title: &str) -> String {

    format!(

        "---\ntitle: {}\ndate: {}\ntags: []\n---\n\n# {}\n\nStart writing here...\n",

        title,

        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),

        title

    )

}
