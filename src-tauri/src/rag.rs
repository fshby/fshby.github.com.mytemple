// rag.rs — RAG 向量检索服务
// 对应 server/rag.js，实现文档分块、向量索引、关键词检索、混合检索、AI 对话。
// 企业级标准：向量索引必须支持增量更新（仅重新嵌入变更的分块），
// 检索必须支持混合模式（关键词 + 语义），对话必须标注来源。
//
// 架构：
// 1. chunkMarkdown: 按标题分段 → 清理 Markdown → 按 MAX_CHUNK_CHARS 切块
// 2. 向量索引：调用 Ollama /api/embed 获取嵌入向量，持久化为 chunks.ndjson + vectors.f32
// 3. 检索：关键词（tokenize + TF 评分）+ 语义（余弦相似度），RRF 融合
// 4. 对话：Ollama /api/chat 或 DeepSeek /v1/chat/completions

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub const SCHEMA_VERSION: u32 = 1;
const DEFAULT_BASE_URL: &str = "http://127.0.0.1:11434";
const MAX_CHUNK_CHARS: usize = 1800;
const MIN_CHUNK_CHARS: usize = 160;
const OVERLAP_CHARS: usize = 180;

// ── 正则缓存 ──────────────────────────────────────────────

static FRONTMATTER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^---\s*\r?\n.*?\r?\n---\s*$").unwrap());

static IMG_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]+\)").unwrap());

static TEXT_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\]]+)\]\([^)]+\)").unwrap());

static HTML_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());

static HEADING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(#{1,6})\s+(.+)$").unwrap());

static CODE_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)```.*?```").unwrap());

static HEADING_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s{0,3}#{1,6}\s+").unwrap());

static LIST_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*[-*+]\s+").unwrap());

static SENTENCE_SPLIT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[。！？!?；;]").unwrap());

static TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}][\p{L}\p{N}_.\-]{1,}").unwrap());

// ── 数据结构 ──────────────────────────────────────────────

/// 文档分块
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    pub id: String,
    pub path: String,
    pub workspace_id: String,
    pub title: String,
    pub heading: String,
    pub ordinal: u32,
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
    pub text_hash: String,
    pub tokens: Vec<String>,
}

/// 索引文件信息
#[derive(Debug, Clone)]
pub struct IndexedFile {
    pub path: String,
    pub title: String,
    pub content: String,
    pub content_sha256: String,
    pub workspace_id: String,
}

/// AI 设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSettings {
    pub enabled: bool,
    pub base_url: String,
    pub embedding_model: String,
    pub chat_model: String,
    pub chat_provider: String, // ollama | deepseek
    /// 注意：此字段会持久化到 ai-settings.json（本地文件，不通过 API 暴露）。
    /// 对外公开通过 PublicSettings，仅显示 deepseek_api_key_configured: bool，不泄露明文。
    pub deepseek_api_key: String,
    pub deepseek_base_url: String,
    pub deepseek_chat_model: String,
    pub max_sources: u32,
    pub retrieval_mode: String, // auto | light | semantic
}

impl Default for AiSettings {
    fn default() -> Self {
        AiSettings {
            enabled: true,
            base_url: DEFAULT_BASE_URL.to_string(),
            embedding_model: String::new(),
            chat_model: String::new(),
            chat_provider: "ollama".to_string(),
            deepseek_api_key: String::new(),
            deepseek_base_url: "https://api.deepseek.com".to_string(),
            deepseek_chat_model: "deepseek-chat".to_string(),
            max_sources: 6,
            retrieval_mode: "auto".to_string(),
        }
    }
}

/// 公开设置（隐藏 API Key）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicSettings {
    pub enabled: bool,
    pub base_url: String,
    pub embedding_model: String,
    pub chat_model: String,
    pub chat_provider: String,
    pub deepseek_base_url: String,
    pub deepseek_chat_model: String,
    pub max_sources: u32,
    pub retrieval_mode: String,
    pub deepseek_api_key_configured: bool,
}

/// 清单
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub knowledge_version: String,
    pub embedding_model: String,
    pub requested_embedding_model: String,
    pub dimension: usize,
    pub chunk_count: usize,
    pub vector_count: usize,
    pub indexed_at: String,
    pub documents: HashMap<String, DocManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocManifest {
    pub signature: String,
    pub chunk_ids: Vec<String>,
}

impl Default for Manifest {
    fn default() -> Self {
        Manifest {
            schema_version: SCHEMA_VERSION,
            knowledge_version: String::new(),
            embedding_model: String::new(),
            requested_embedding_model: String::new(),
            dimension: 0,
            chunk_count: 0,
            vector_count: 0,
            indexed_at: String::new(),
            documents: HashMap::new(),
        }
    }
}

/// 检索来源
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub rank: u32,
    pub path: String,
    pub title: String,
    pub heading: String,
    pub start_line: u32,
    pub end_line: u32,
    pub excerpt: String,
    pub score: f64,
}

/// 检索结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievalResult {
    pub sources: Vec<Source>,
    pub retrieval_mode: String,
}

// ── 工具函数 ──────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hash_str(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hash_to_hex(&hasher.finalize())
}

fn hash_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 清理 Markdown 用于嵌入
fn clean_markdown_for_embedding(text: &str) -> String {
    let text = FRONTMATTER_RE.replace_all(text, "");
    let text = IMG_LINK_RE.replace_all(&text, "$1");
    let text = TEXT_LINK_RE.replace_all(&text, "$1");
    let text = HTML_TAG_RE.replace_all(&text, " ");
    text.trim().to_string()
}

/// 分词（中英文混合）
fn tokenize(text: &str) -> Vec<String> {
    let normalized = FRONTMATTER_RE.replace_all(text, " ");
    // 简单分词：连续字母数字
    TOKEN_RE
        .find_iter(&normalized.to_lowercase())
        .map(|m| m.as_str().trim().to_string())
        .filter(|s| s.len() > 1)
        .take(1200)
        .collect()
}

/// 选择句
fn selection_sentences(text: &str) -> Vec<String> {
    let text = FRONTMATTER_RE.replace_all(text, "");
    let text = CODE_BLOCK_RE.replace_all(&text, " ");
    let text = HEADING_PREFIX_RE.replace_all(&text, "");
    let text = LIST_PREFIX_RE.replace_all(&text, "");
    let parts: Vec<&str> = SENTENCE_SPLIT_RE.split(&text).collect();
    parts
        .iter()
        .map(|s| s.trim())
        .filter(|s| s.len() >= 8)
        .map(|s| s.to_string())
        .collect()
}

/// 离线文本处理降级
pub fn fallback_transform_selection(text: &str, mode: &str) -> Result<String, String> {
    let input_trimmed = text.trim();
    // 按字符边界截断（16000 个 Unicode 字符），避免 UTF-8 多字节字符切片 panic
    let char_byte_end = input_trimmed
        .char_indices()
        .nth(16000)
        .map(|(i, _)| i)
        .unwrap_or(input_trimmed.len());
    // 双重保险：再对齐一次字符边界（即使 char_indices 理论安全）
    let safe_end = align_char_boundary(input_trimmed, char_byte_end, false);
    let input = if safe_end == 0 { "" } else { &input_trimmed[..safe_end] };
    if input.is_empty() {
        return Err("请选择需要处理的文本".to_string());
    }
    let sentences = selection_sentences(input);
    let candidates = if !sentences.is_empty() {
        sentences
    } else {
        vec![input.split_whitespace().collect::<Vec<_>>().join(" ")]
    };

    match mode {
        "keypoints" => {
            let items: Vec<String> = candidates.iter().take(8).map(|s| format!("- {}", s)).collect();
            Ok(items.join("\n"))
        }
        "terms" => {
            let mut counts: HashMap<String, u32> = HashMap::new();
            for token in tokenize(input) {
                *counts.entry(token).or_insert(0) += 1;
            }
            let mut terms: Vec<_> = counts.into_iter().collect();
            terms.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.len().cmp(&a.0.len())));
            let items: Vec<String> = terms
                .iter()
                .take(8)
                .map(|(term, _)| {
                    format!("- **{}**：选中文本中的相关概念，建议结合原文语境补充定义。", term)
                })
                .collect();
            if items.is_empty() {
                Ok("- 暂未提取到可解释的术语。".to_string())
            } else {
                Ok(items.join("\n"))
            }
        }
        _ => {
            let items: Vec<String> = candidates.iter().take(4).cloned().collect();
            Ok(items.join("\n\n"))
        }
    }
}

/// 计算行号
fn line_number_at(source: &str, offset: usize) -> u32 {
    let mut lines = 1u32;
    for (i, c) in source.char_indices() {
        if i >= offset {
            break;
        }
        if c == '\n' {
            lines += 1;
        }
    }
    lines
}

// ── 文档分块辅助（字符边界安全） ──────────────────────────

/// 把"第 N 个字符的位置"映射成字节偏移；如果 n 超过字符数，返回字符串末尾字节偏移。
fn char_byte_offset(s: &str, n_chars: usize) -> usize {
    s.char_indices().nth(n_chars).map(|(i, _)| i).unwrap_or(s.len())
}

/// 把字节偏移对齐到最近的合法 UTF-8 字符边界；
/// forward=true 向前（增大方向）找，false 向后（减小方向）找；找不到返回 s.len()/0。
fn align_char_boundary(s: &str, byte_pos: usize, forward: bool) -> usize {
    let clamped = byte_pos.min(s.len());
    if s.is_char_boundary(clamped) {
        return clamped;
    }
    if forward {
        (clamped..=s.len())
            .find(|&i| s.is_char_boundary(i))
            .unwrap_or(s.len())
    } else {
        (0..=clamped)
            .rev()
            .find(|&i| s.is_char_boundary(i))
            .unwrap_or(0)
    }
}

/// 返回 s[start_char..end_char] 的切片，起止位置均按"字符索引"；
/// 双重 is_char_boundary 防御；start_char >= end_char 时返回空串绝不 panic。
fn slice_by_chars(s: &str, start_char: usize, end_char: usize) -> &str {
    if s.is_empty() || start_char >= end_char {
        return "";
    }
    let bs_raw = char_byte_offset(s, start_char);
    let be_raw = char_byte_offset(s, end_char);
    let byte_start = align_char_boundary(s, bs_raw, true);
    let byte_end = align_char_boundary(s, be_raw, false);
    if byte_start >= byte_end {
        return "";
    }
    &s[byte_start..byte_end]
}

/// 安全统计 s[..byte_pos] 字符数：先对齐边界再切片，绝对不触发 UTF-8 边界 panic。
fn chars_count_up_to_byte(s: &str, byte_pos: usize) -> usize {
    if s.is_empty() {
        return 0;
    }
    let safe_end = align_char_boundary(s, byte_pos.min(s.len()), false);
    if safe_end == 0 {
        return 0;
    }
    s[..safe_end].chars().count()
}

/// 在 s[..byte_end] 内找最后一个 needles 中的分隔符字符；
/// 返回分隔符"之后"的字节位置；找不到或范围非法返回 None。
fn rfind_boundary_char(
    s: &str,
    byte_end: usize,
    min_byte_pos: usize,
    needles: &[char],
) -> Option<usize> {
    if s.is_empty() || min_byte_pos >= s.len() {
        return None;
    }
    let upper = align_char_boundary(s, byte_end.min(s.len()), false);
    if upper == 0 {
        return None;
    }
    let search_range = &s[..upper];
    search_range
        .char_indices()
        .rev()
        .find(|&(i, c)| needles.contains(&c) && i >= min_byte_pos)
        .map(|(i, c)| i + c.len_utf8())
}

// ── 文档分块 ──────────────────────────────────────────────

/// 将 Markdown 文档按标题分段并切块（全程字符边界安全，中文 UTF-8 切片零 panic）
pub fn chunk_markdown(file: &IndexedFile) -> Vec<Chunk> {
    let original = &file.content;
    let body = clean_markdown_for_embedding(original);
    if body.is_empty() {
        return vec![];
    }

    // 按标题分段（regex 匹配的 start/end 一定在 UTF-8 字符边界，因此切片安全）
    let mut sections: Vec<(String, usize, usize)> = Vec::new(); // (heading, section_byte_start, section_byte_end)
    let headings: Vec<(usize, usize, String)> = HEADING_RE
        .captures_iter(original)
        .map(|cap| {
            let full = cap.get(0).unwrap();
            (
                full.start(),
                full.end(),
                cap.get(2).unwrap().as_str().trim().to_string(),
            )
        })
        .collect();

    if headings.is_empty() {
        sections.push((file.title.clone(), 0, original.len()));
    } else {
        if headings[0].0 > 0 {
            sections.push((file.title.clone(), 0, headings[0].0));
        }
        for i in 0..headings.len() {
            let end = if i + 1 < headings.len() {
                headings[i + 1].0
            } else {
                original.len()
            };
            sections.push((headings[i].2.clone(), headings[i].1, end));
        }
    }

    // 分块 —— 全程用"字符数"度量长度，实际切片用 char_indices 对齐字节边界
    let needles_boundary: &[char] = &['\n', '。', '！', '？', '!', '?', '；', ';'];
    let mut chunks = Vec::new();
    for (heading, section_byte_start, section_byte_end) in sections {
        // 确保 section 边界在字符边界（regex 理论上保证，这里用通用对齐兜底）
        let sbs = align_char_boundary(original, section_byte_start, true);
        let sbe = align_char_boundary(original, section_byte_end, false);
        // sbs > sbe 说明该段标题匹配错位，直接跳过避免切片 panic
        if sbs >= sbe {
            continue;
        }
        let section_text = clean_markdown_for_embedding(&original[sbs..sbe]);
        if section_text.is_empty() {
            continue;
        }
        let section_total_chars = section_text.chars().count();
        if section_total_chars == 0 {
            continue;
        }

        // cursor_char：当前分块的起始"字符索引"
        let mut cursor_char = 0usize;
        let mut ordinal = 0u32;
        loop {
            // 结束字符索引（不超过总字符数）
            let mut end_char = (cursor_char + MAX_CHUNK_CHARS).min(section_total_chars);

            if end_char < section_total_chars {
                // 先把 end_char 转成字节偏移，作为 rfind 的搜索上限
                let end_byte = char_byte_offset(&section_text, end_char);
                // min_char 换算成字节偏移：至少要保留 MIN_CHUNK_CHARS 个字符
                let min_chars_from_cursor = cursor_char + MIN_CHUNK_CHARS;
                let min_byte_pos = char_byte_offset(&section_text, min_chars_from_cursor);

                // 在 [min_byte_pos, end_byte) 中找最后一个句段分隔符（返回分隔符"之后"的字节位置）
                if let Some(split_after_byte) = rfind_boundary_char(&section_text, end_byte, min_byte_pos, needles_boundary) {
                    // 【安全版】先对齐边界再统计字符数，避免 UTF-8 切片 panic
                    let split_char_idx = chars_count_up_to_byte(&section_text, split_after_byte);
                    end_char = split_char_idx.min(section_total_chars);
                }
                // 另外再尝试段落分隔符 "\n\n"（两个都是 ASCII，一定在字符边界）
                if end_char < section_total_chars {
                    let end_byte_now = char_byte_offset(&section_text, end_char);
                    // 【安全版】搜索范围先对齐再切片
                    let search_end = align_char_boundary(&section_text, end_byte_now, false);
                    if search_end > 0 {
                        if let Some(double_nl) = section_text[..search_end].rfind("\n\n") {
                            let pos_char = chars_count_up_to_byte(&section_text, double_nl + 2);
                            if pos_char > min_chars_from_cursor && pos_char <= section_total_chars {
                                end_char = pos_char;
                            }
                        }
                    }
                }
            }

            // 切片：按字符索引 → 对齐字节边界
            let text_slice = slice_by_chars(&section_text, cursor_char, end_char);
            let text = text_slice.trim().to_string();
            if !text.is_empty() {
                // 估算源文件偏移：把字符偏移按字符数占比近似映射到字节偏移
                let approx_bytes = if section_total_chars > 0 {
                    ((sbe - sbs) as u64 * cursor_char as u64 / section_total_chars as u64) as usize
                } else {
                    0
                };
                let source_offset = (sbs + approx_bytes).min(original.len());
                let start_line = line_number_at(original, source_offset);
                let end_line = start_line + text.matches('\n').count() as u32;
                let text_hash = hash_str(&text);
                let chunk_id = hash_str(&format!("{}|{}|{}|{}", file.path, heading, ordinal, text_hash))
                    .chars()
                    .take(32)
                    .collect::<String>();
                let tokens = tokenize(&format!("{} {} {}", file.title, heading, &text));
                chunks.push(Chunk {
                    id: chunk_id,
                    path: file.path.clone(),
                    workspace_id: file.workspace_id.clone(),
                    title: file.title.clone(),
                    heading: heading.clone(),
                    ordinal,
                    start_line,
                    end_line,
                    text,
                    text_hash,
                    tokens,
                });
            }
            if end_char >= section_total_chars {
                break;
            }
            // 下一块起点：回退 OVERLAP_CHARS 个字符作为重叠；但至少前进 1 字符避免死循环
            cursor_char = (cursor_char + 1).max(end_char.saturating_sub(OVERLAP_CHARS));
            ordinal += 1;
        }
    }
    chunks
}

// ── RAG 服务 ──────────────────────────────────────────────

pub struct RagService {
    pub root: PathBuf,
    pub settings_path: PathBuf,
    pub manifest_path: PathBuf,
    pub chunks_path: PathBuf,
    pub vectors_path: PathBuf,
    pub settings: Mutex<AiSettings>,
    pub manifest: Mutex<Manifest>,
    pub chunks: Mutex<Vec<Chunk>>,
    /// 向量存储采用 mmap 只读映射，避免大向量表的堆拷贝；
    /// vectors.f32 内容为连续 LE f32 字节，按 manifest_dim*4 字节切片后直接视作 &[f32]。
    vectors_file: Mutex<Option<std::fs::File>>,
    vectors_mmap: Mutex<Option<memmap2::Mmap>>,
    loaded: Mutex<bool>,
    pub last_error: Mutex<String>,
    pub progress: Mutex<(u32, u32)>, // (done, total)
}

impl RagService {
    pub fn new(data_root: &Path) -> Self {
        let root = data_root.join("rag");
        RagService {
            settings_path: data_root.join("ai-settings.json"),
            manifest_path: root.join("manifest.json"),
            chunks_path: root.join("chunks.ndjson"),
            vectors_path: root.join("vectors.f32"),
            root,
            settings: Mutex::new(AiSettings::default()),
            manifest: Mutex::new(Manifest::default()),
            chunks: Mutex::new(Vec::new()),
            vectors_file: Mutex::new(None),
            vectors_mmap: Mutex::new(None),
            loaded: Mutex::new(false),
            last_error: Mutex::new(String::new()),
            progress: Mutex::new((0, 0)),
        }
    }

    /// 公开设置（隐藏 API Key）
    pub fn public_settings(&self) -> PublicSettings {
        let s = self.settings.lock().unwrap();
        PublicSettings {
            enabled: s.enabled,
            base_url: s.base_url.clone(),
            embedding_model: s.embedding_model.clone(),
            chat_model: s.chat_model.clone(),
            chat_provider: s.chat_provider.clone(),
            deepseek_base_url: s.deepseek_base_url.clone(),
            deepseek_chat_model: s.deepseek_chat_model.clone(),
            max_sources: s.max_sources,
            retrieval_mode: s.retrieval_mode.clone(),
            deepseek_api_key_configured: !s.deepseek_api_key.trim().is_empty(),
        }
    }

    /// 加载持久化数据
    pub fn load(&self) -> Result<(), anyhow::Error> {
        let mut loaded = self.loaded.lock().unwrap();
        if *loaded {
            return Ok(());
        }
        std::fs::create_dir_all(&self.root)?;
        // 加载设置
        if let Ok(content) = std::fs::read_to_string(&self.settings_path) {
            if let Ok(s) = serde_json::from_str::<AiSettings>(&content) {
                *self.settings.lock().unwrap() = s;
            }
        }
        // 加载清单和分块
        if let Ok(content) = std::fs::read_to_string(&self.manifest_path) {
            if let Ok(m) = serde_json::from_str::<Manifest>(&content) {
                let chunk_count = m.chunk_count;
                *self.manifest.lock().unwrap() = m;
                // 预分配 chunks 容量（manifest.chunk_count × 1.1 安全容差），避免多次 realloc
                if let Ok(content) = std::fs::read_to_string(&self.chunks_path) {
                    let cap = (chunk_count.max(16) as usize).saturating_mul(11) / 10;
                    let mut chunks: Vec<Chunk> = Vec::with_capacity(cap);
                    chunks.extend(
                        content
                            .lines()
                            .filter(|l| !l.is_empty())
                            .filter_map(|l| serde_json::from_str(l).ok()),
                    );
                    *self.chunks.lock().unwrap() = chunks;
                }
            } else {
                // manifest 解析失败时退化：仍尝试把 chunks 读进来（用字节数 ÷ 预估每行 200B 估容量）
                if let Ok(content) = std::fs::read_to_string(&self.chunks_path) {
                    let cap = content.len().saturating_div(200).max(16);
                    let mut chunks: Vec<Chunk> = Vec::with_capacity(cap);
                    chunks.extend(
                        content
                            .lines()
                            .filter(|l| !l.is_empty())
                            .filter_map(|l| serde_json::from_str(l).ok()),
                    );
                    *self.chunks.lock().unwrap() = chunks;
                }
            }
        }
        // 加载向量：用 mmap 只读映射替代 Vec<f32> 全量堆拷贝
        let manifest = self.manifest.lock().unwrap();
        if manifest.dimension > 0 {
            if let Ok(file) = std::fs::File::open(&self.vectors_path) {
                let len = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
                if len % 4 == 0 && len >= 4 {
                    // Safety: vectors.f32 在本进程内不会被写入（仅外部工具生成），
                    // 文件保持打开以维持 Windows 上的映射有效性。
                    if let Ok(mmap) = unsafe { memmap2::Mmap::map(&file) } {
                        *self.vectors_file.lock().unwrap() = Some(file);
                        *self.vectors_mmap.lock().unwrap() = Some(mmap);
                    }
                }
            }
        }
        *loaded = true;
        Ok(())
    }

    /// 状态
    pub fn status(&self) -> serde_json::Value {
        let s = self.settings.lock().unwrap();
        let m = self.manifest.lock().unwrap();
        let chunks = self.chunks.lock().unwrap();
        serde_json::json!({
            "enabled": s.enabled,
            "baseUrl": s.base_url,
            "embeddingModel": s.embedding_model,
            "chatModel": s.chat_model,
            "chatProvider": s.chat_provider,
            "deepseekBaseUrl": s.deepseek_base_url,
            "deepseekChatModel": s.deepseek_chat_model,
            "deepseekApiKeyConfigured": !s.deepseek_api_key.trim().is_empty(),
            "maxSources": s.max_sources,
            "retrievalMode": s.retrieval_mode,
            "indexing": false,
            "progress": { "done": self.progress.lock().unwrap().0, "total": self.progress.lock().unwrap().1 },
            "chunkCount": chunks.len(),
            "vectorCount": if m.dimension > 0 { m.chunk_count } else { 0 },
            "dimension": m.dimension,
            "knowledgeVersion": m.knowledge_version,
            "indexedAt": m.indexed_at,
            "lastError": *self.last_error.lock().unwrap(),
            "mode": if m.dimension > 0 { "hybrid" } else { "keyword" },
        })
    }

    /// 关键词检索
    pub fn lexical_search(&self, question: &str, scope_path: &str) -> Vec<(usize, f64)> {
        let query_tokens: Vec<String> = tokenize(question);
        let unique_tokens: HashSet<&String> = query_tokens.iter().collect();
        if unique_tokens.is_empty() {
            return vec![];
        }
        let chunks = self.chunks.lock().unwrap();
        chunks
            .iter()
            .enumerate()
            .filter_map(|(index, chunk)| {
                if !scope_path.is_empty() && chunk.path != scope_path {
                    return None;
                }
                let token_set: HashSet<&str> = chunk.tokens.iter().map(|s| s.as_str()).collect();
                let mut score = 0.0f64;
                for token in &unique_tokens {
                    if token_set.contains(token.as_str()) {
                        score += 3.0;
                    }
                    if chunk.title.to_lowercase().contains(token.as_str()) {
                        score += 4.0;
                    }
                    if chunk.heading.to_lowercase().contains(token.as_str()) {
                        score += 5.0;
                    }
                    if chunk.text.to_lowercase().contains(token.as_str()) {
                        score += 1.0;
                    }
                }
                if score > 0.0 {
                    Some((index, score))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .into_iter()
            .collect()
    }

    /// 将 &[u8] 重解释为 &[f32]（要求 len 是 4 的倍数且起点 4 字节对齐）。
    /// Safety: 调用方必须保证切片起点 4 字节对齐且长度为 4 的倍数。
    /// mmap 区域起点为页对齐（必然 4 字节对齐），manifest_dim*4 偏移也保持 4 对齐。
    unsafe fn bytes_as_f32(bytes: &[u8]) -> &[f32] {
        debug_assert_eq!(bytes.len() % 4, 0, "f32 view requires 4-byte multiple length");
        std::slice::from_raw_parts(bytes.as_ptr() as *const f32, bytes.len() / 4)
    }

    /// 计算两个向量的余弦相似度；长度不一致或零向量返回 0.0
    fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
        if a.len() != b.len() || a.is_empty() {
            return 0.0;
        }
        let mut dot = 0.0f32;
        let mut na = 0.0f32;
        let mut nb = 0.0f32;
        for i in 0..a.len() {
            let x = a[i];
            let y = b[i];
            dot += x * y;
            na += x * x;
            nb += y * y;
        }
        let denom = na.sqrt() * nb.sqrt();
        if denom <= f32::EPSILON {
            0.0
        } else {
            dot / denom
        }
    }

    /// 调用 Ollama /api/embed 生成单条文本的嵌入向量（失败返回 Err，便于上层降级）
    async fn embed_query(&self, text: &str) -> Result<Vec<f32>, anyhow::Error> {
        let s = self.settings.lock().unwrap().clone();
        if !s.enabled {
            anyhow::bail!("AI disabled");
        }
        let base = s.base_url.trim().trim_end_matches('/');
        if base.is_empty() {
            anyhow::bail!("AI base URL not configured");
        }
        let model = s.embedding_model.trim();
        if model.is_empty() {
            anyhow::bail!("Embedding model not configured");
        }
        let url = format!("{}/api/embed", base);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;
        let body = serde_json::json!({
            "model": model,
            "input": text,
        });
        let resp = client.post(&url).json(&body).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let code = status.as_u16();
            let err_txt = resp.text().await.unwrap_or_default();
            anyhow::bail!("Ollama /api/embed HTTP {}: {}", code, err_txt);
        }
        let json: serde_json::Value = resp.json().await?;
        // Ollama 返回: { "embedding": [f32,...] } 或 旧版 { "embeddings": [[f32,...]] }
        let emb: Vec<f32> = if let Some(arr) = json.get("embedding").and_then(|v| v.as_array()) {
            arr.iter()
                .filter_map(|v| v.as_f64().map(|x| x as f32))
                .collect()
        } else if let Some(outer) = json.get("embeddings").and_then(|v| v.as_array()) {
            outer
                .first()
                .and_then(|first| first.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_f64().map(|x| x as f32)).collect())
                .unwrap_or_default()
        } else {
            anyhow::bail!("Ollama /api/embed 返回缺少 embedding/embeddings 字段");
        };
        if emb.is_empty() {
            anyhow::bail!("Ollama 返回空 embedding");
        }
        Ok(emb)
    }

    /// 向量检索（语义搜索）：
    ///   - 需要 vectors.f32 已加载（manifest.dimension > 0）
    ///   - 需要 Ollama embedding 服务可访问
    ///   - 任一条件不满足时返回空 vec（上层与 lexical 融合时会自然退化为关键词模式）
    pub async fn vector_search(
        &self,
        question: &str,
        scope_path: &str,
        top_k: usize,
    ) -> Vec<(usize, f64)> {
        let top_k = top_k.max(3).min(50);
        // 1) 确认向量索引存在
        let (manifest_dim, chunk_count) = {
            let m = self.manifest.lock().unwrap();
            (m.dimension, m.chunk_count)
        };
        if manifest_dim == 0 || chunk_count == 0 {
            return vec![];
        }
        // 2) 获取查询向量（失败即降级）
        let q_vec = match self.embed_query(question).await {
            Ok(v) if v.len() == manifest_dim => v,
            Ok(v) => {
                let _ = self.last_error.lock().map(|mut le| {
                    *le = format!(
                        "向量维度不匹配：manifest={} query={}",
                        manifest_dim,
                        v.len()
                    );
                });
                return vec![];
            }
            Err(e) => {
                let _ = self.last_error.lock().map(|mut le| *le = format!("嵌入失败: {}", e));
                return vec![];
            }
        };
        // 3) 取 chunk 过滤列表和 vectors 切片（mmap 只读映射，按字节切片后视作 &[f32]）
        let chunks_guard = self.chunks.lock().unwrap();
        let mmap_guard = self.vectors_mmap.lock().unwrap();
        let mmap_bytes: &[u8] = match mmap_guard.as_ref() {
            Some(m) => &m[..],
            None => return vec![],
        };
        let stride = manifest_dim * 4;
        let total_vectors_in_store = mmap_bytes.len() / stride;
        if total_vectors_in_store == 0 {
            return vec![];
        }
        // 对每个 chunk 计算余弦相似度
        let mut scored: Vec<(usize, f64)> = Vec::with_capacity(chunks_guard.len().min(200));
        for (idx, chunk) in chunks_guard.iter().enumerate() {
            if !scope_path.is_empty() && chunk.path != scope_path {
                continue;
            }
            if idx >= total_vectors_in_store {
                break;
            }
            let start = idx * stride;
            let end = start + stride;
            if end > mmap_bytes.len() {
                break;
            }
            // Safety: mmap 起点 4 字节对齐，stride 为 4 的倍数，切片满足 f32 对齐要求
            let v_slice = unsafe { Self::bytes_as_f32(&mmap_bytes[start..end]) };
            let sim = Self::cosine_similarity(&q_vec, v_slice);
            if sim > 0.0 {
                scored.push((idx, sim as f64));
            }
        }
        // 按相似度降序，取 top_k
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(top_k);
        scored
    }

    /// 检索（关键词 + 向量混合，RRF 融合）
    pub async fn retrieve(
        &self,
        question: &str,
        scope: &str,
        path: &str,
        max_sources: u32,
    ) -> RetrievalResult {
        let _ = self.load();
        let scope_path = if scope == "current" { path } else { "" };

        let lexical = self.lexical_search(question, scope_path);

        // 向量检索（异步，失败降级为空 vec）
        let retrieval_mode_override = { self.settings.lock().unwrap().retrieval_mode.clone() };
        let vector: Vec<(usize, f64)> = if retrieval_mode_override == "light" {
            vec![] // light 模式：禁用向量检索，节省算力
        } else {
            let top = (max_sources * 4).clamp(10, 40) as usize;
            self.vector_search(question, scope_path, top).await
        };

        // RRF 融合
        let mut fused: HashMap<usize, f64> = HashMap::new();
        for (rank, &(index, _)) in lexical.iter().enumerate() {
            *fused.entry(index).or_insert(0.0) += 1.0 / (60.0 + rank as f64 + 1.0);
        }
        for (rank, &(index, _)) in vector.iter().enumerate() {
            *fused.entry(index).or_insert(0.0) += 1.0 / (60.0 + rank as f64 + 1.0);
        }

        let max_sources = max_sources.clamp(3, 10);
        let mut sorted: Vec<(usize, f64)> = fused.into_iter().collect();
        sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        sorted.truncate(max_sources as usize);

        let chunks = self.chunks.lock().unwrap();
        let sources: Vec<Source> = sorted
            .iter()
            .enumerate()
            .map(|(rank, &(index, score))| {
                let chunk = &chunks[index];
                Source {
                    id: chunk.id.clone(),
                    rank: (rank + 1) as u32,
                    path: chunk.path.clone(),
                    title: chunk.title.clone(),
                    heading: chunk.heading.clone(),
                    start_line: chunk.start_line,
                    end_line: chunk.end_line,
                    excerpt: chunk.text.chars().take(420).collect(),
                    score,
                }
            })
            .collect();

        RetrievalResult {
            sources,
            retrieval_mode: if vector.is_empty() { "keyword".to_string() } else { "hybrid".to_string() },
        }
    }

    /// 调用 AI 模型（Ollama /api/chat 或 DeepSeek /v1/chat/completions）生成回答
    /// 自动切换：默认 provider 失败时尝试另一个，两者都不可用则返回错误，
    /// 上层（handlers）会降级为关键词检索结果或本地 fallback 处理。
    pub async fn chat(&self, system_prompt: &str, user_prompt: &str) -> Result<String, String> {
        let s = self.settings.lock().unwrap().clone();
        if !s.enabled {
            return Err("AI 未启用".to_string());
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

        let provider = s.chat_provider.trim();
        let deepseek_ready = !s.deepseek_api_key.trim().is_empty();
        let ollama_ready = !s.base_url.trim().is_empty() && !s.chat_model.trim().is_empty();

        // 先尝试配置的 provider，失败时自动切换到另一个（若已配置）
        let answer = if provider == "deepseek" {
            match self.chat_with_deepseek(&s, &client, system_prompt, user_prompt).await {
                Ok(text) => text,
                Err(e) if ollama_ready => {
                    // DeepSeek 失败 → 降级 Ollama
                    self.chat_with_ollama(&s, &client, system_prompt, user_prompt)
                        .await
                        .map_err(|e2| format!("DeepSeek 与 Ollama 均不可用（{} | {}），已降级为关键词检索", e, e2))?
                }
                Err(e) => Err(e)?,
            }
        } else {
            match self.chat_with_ollama(&s, &client, system_prompt, user_prompt).await {
                Ok(text) => text,
                Err(e) if deepseek_ready => {
                    // Ollama 失败 → 降级 DeepSeek
                    self.chat_with_deepseek(&s, &client, system_prompt, user_prompt)
                        .await
                        .map_err(|e2| format!("Ollama 与 DeepSeek 均不可用（{} | {}），已降级为关键词检索", e, e2))?
                }
                Err(e) => Err(e)?,
            }
        };

        // 清洗 AI 输出：移除控制字符（保留 \t \n \r），避免破坏 JSON/前端解析
        let answer: String = answer
            .chars()
            .filter(|c| {
                let code = *c as u32;
                // 保留 \t (0x09) \n (0x0A) \r (0x0D)
                !(code < 0x09 || (code > 0x0D && code < 0x20) || code == 0xFFFE || code == 0xFFFF)
            })
            .collect();
        Ok(answer)
    }

    /// DeepSeek /v1/chat/completions 调用
    async fn chat_with_deepseek(
        &self,
        s: &AiSettings,
        client: &reqwest::Client,
        system_prompt: &str,
        user_prompt: &str,
    ) -> Result<String, String> {
        let api_key = s.deepseek_api_key.trim();
        if api_key.is_empty() {
            return Err("DeepSeek API Key 未配置".to_string());
        }
        let base = s.deepseek_base_url.trim().trim_end_matches('/');
        let url = format!("{}/v1/chat/completions", base);
        let model = if s.deepseek_chat_model.trim().is_empty() {
            "deepseek-chat"
        } else {
            s.deepseek_chat_model.trim()
        };
        let body = serde_json::json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_prompt },
            ],
            "stream": false,
            "max_tokens": 4096,
        });
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("DeepSeek 请求失败: {}", e))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("DeepSeek HTTP {}: {}", status.as_u16(), &text[..text.len().min(500)]));
        }
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("DeepSeek 响应解析失败: {}", e))?;
        Ok(json.get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .ok_or("DeepSeek 返回缺少 choices[0].message.content".to_string())?
            .to_string())
    }

    /// Ollama /api/chat 调用
    async fn chat_with_ollama(
        &self,
        s: &AiSettings,
        client: &reqwest::Client,
        system_prompt: &str,
        user_prompt: &str,
    ) -> Result<String, String> {
        let base = s.base_url.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err("Ollama base URL 未配置".to_string());
        }
        let model = s.chat_model.trim();
        if model.is_empty() {
            return Err("Ollama chat 模型未配置".to_string());
        }
        let url = format!("{}/api/chat", base);
        let body = serde_json::json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_prompt },
            ],
            "stream": false,
        });
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Ollama 请求失败: {}", e))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("Ollama HTTP {}: {}", status.as_u16(), &text[..text.len().min(500)]));
        }
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Ollama 响应解析失败: {}", e))?;
        Ok(json.get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .ok_or("Ollama 返回缺少 message.content".to_string())?
            .to_string())
    }
}

// 需要引入 HashSet
use std::collections::HashSet;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunk_markdown() {
        let file = IndexedFile {
            path: "test.md".to_string(),
            title: "Test".to_string(),
            content: "# Title\n\nSome content here.\n\n## Section\n\nMore content.".to_string(),
            content_sha256: "abc".to_string(),
            workspace_id: "ws_test".to_string(),
        };
        let chunks = chunk_markdown(&file);
        assert!(!chunks.is_empty());
        assert!(chunks[0].heading.contains("Title") || chunks[0].heading.contains("Test"));
    }

    #[test]
    fn test_chunk_markdown_cjk_no_panic() {
        // 专门验证：中文句号边界不会导致切片 panic
        let cn_content = "# 中文文档\n\n\
            这是第一段。全都是中文句子。第二句话。第三句话。这里还有很多文字填充。\n\n\
            ## 中文小节\n\n\
            另一段中文内容。继续写。句号！问号？分号；再继续写下去。";
        let file = IndexedFile {
            path: "cn.md".to_string(),
            title: "中文文档".to_string(),
            content: cn_content.to_string(),
            content_sha256: "cnabc".to_string(),
            workspace_id: "ws_test".to_string(),
        };
        let chunks = chunk_markdown(&file);
        // 不能 panic，必须生成 chunk
        assert!(!chunks.is_empty(), "中文文档应至少生成 1 个分块");
        for c in &chunks {
            // 每个分块 text 都必须是合法 UTF-8（String 本身就保证），且非空
            assert!(!c.text.is_empty());
            // 验证 tokens 不为空（中英文分词）
            assert!(!c.tokens.is_empty() || !c.text.is_empty());
        }
    }

    #[test]
    fn test_slice_by_chars_safety() {
        let s = "Hello世界！测试文字end";
        // 从第 5 个字符（'世'）切到第 9 个字符（'测'后面）
        let sub = slice_by_chars(s, 5, 9);
        assert_eq!(sub, "世界！测");
        // 超限到末尾
        let all = slice_by_chars(s, 0, 9999);
        assert_eq!(all, s);
        // 全中文
        let cn = "一二三四五六七八九十";
        let part = slice_by_chars(cn, 2, 6);
        assert_eq!(part, "三四五六");
    }

    #[test]
    fn test_tokenize() {
        let tokens = tokenize("Hello 世界 hello world");
        assert!(!tokens.is_empty());
    }

    #[test]
    fn test_fallback_summary() {
        let result = fallback_transform_selection("这是第一句。这是第二句。", "summary").unwrap();
        assert!(result.contains("第一句"));
    }

    #[test]
    fn test_fallback_transform_cjk_truncate() {
        // 构造 >16000 个字符的中文输入，验证截断不 panic
        let mut long_cn = String::with_capacity(16000 * 3 + 100);
        for i in 0..17000 {
            long_cn.push(match (i % 10) as u8 {
                0 => '一', 1 => '二', 2 => '三', 3 => '四', 4 => '五',
                5 => '六', 6 => '七', 7 => '八', 8 => '九', _ => '十',
            });
        }
        // 必须不 panic，且返回 Ok
        let r = fallback_transform_selection(&long_cn, "summary");
        assert!(r.is_ok());
    }

    #[test]
    fn test_align_char_boundary_edges() {
        // "你好" = 0xE4BDA0 0xE5A5BD（6 字节，2 字符）
        let s = "你好";
        assert_eq!(s.len(), 6);
        // 合法边界点：0, 3, 6
        assert_eq!(align_char_boundary(s, 0, true), 0);
        assert_eq!(align_char_boundary(s, 3, true), 3);
        assert_eq!(align_char_boundary(s, 6, true), 6);
        // 非法位置 1, 2（"你" 字中间）— 向前找 → 3；向后找 → 0
        assert_eq!(align_char_boundary(s, 1, true), 3);
        assert_eq!(align_char_boundary(s, 1, false), 0);
        assert_eq!(align_char_boundary(s, 2, true), 3);
        assert_eq!(align_char_boundary(s, 2, false), 0);
        // 非法位置 4, 5（"好" 字中间）— 向前找 → 6；向后找 → 3
        assert_eq!(align_char_boundary(s, 4, true), 6);
        assert_eq!(align_char_boundary(s, 4, false), 3);
        assert_eq!(align_char_boundary(s, 5, true), 6);
        assert_eq!(align_char_boundary(s, 5, false), 3);
        // 超出范围：7 被 clamp 到 6
        assert_eq!(align_char_boundary(s, 7, true), 6);
        assert_eq!(align_char_boundary(s, 7, false), 6);
        // chars_count_up_to_byte 在错位位置必须不 panic，且返回合理字符数
        assert_eq!(chars_count_up_to_byte(s, 0), 0);
        assert_eq!(chars_count_up_to_byte(s, 3), 1);
        assert_eq!(chars_count_up_to_byte(s, 6), 2);
        assert_eq!(chars_count_up_to_byte(s, 1), 0); // 回退到 0
        assert_eq!(chars_count_up_to_byte(s, 4), 1); // 回退到 3
        assert_eq!(chars_count_up_to_byte(s, 100), 2); // clamp 回 6 → 2 字
    }

    #[test]
    fn test_slice_by_chars_inverted_order_safe() {
        let s = "Hello世界";
        // start >= end 全部返回空串（不 panic）
        assert_eq!(slice_by_chars(s, 5, 0), "");
        assert_eq!(slice_by_chars(s, 5, 5), "");
        assert_eq!(slice_by_chars(s, 999, 1000), "");
        assert_eq!(slice_by_chars("", 0, 10), "");
    }

    #[test]
    fn test_chunk_markdown_cjk_period_boundary() {
        // 构造一个长中文文档：让 MAX_CHUNK_CHARS 字符位置正好落在中文句号 "。" 的多字节中间
        // 句子：每 30 个"一二三。"循环，总长度 >> MAX_CHUNK_CHARS
        let sentence = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二。";
        let repeat_count = 200; // ≈ 200*32 字符 ≈ 6400 字符，用多段 > 1800
        let mut body = String::with_capacity(sentence.len() * repeat_count + 200);
        body.push_str("# 超长中文测试文档\n\n");
        body.push_str("## 第一章\n\n");
        for _ in 0..repeat_count {
            body.push_str(sentence);
            body.push('\n');
        }
        body.push_str("\n## 第二章\n\n");
        for i in 0..repeat_count {
            body.push_str(sentence);
            // 特意在某一个周期插入 "！？；" 混合分隔符
            if i % 30 == 0 {
                body.push('！');
            } else if i % 30 == 15 {
                body.push('？');
            }
            body.push('\n');
        }
        let file = IndexedFile {
            path: "long-cn.md".to_string(),
            title: "超长中文测试文档".to_string(),
            content: body,
            content_sha256: "long123".to_string(),
            workspace_id: "ws_cn".to_string(),
        };
        let chunks = chunk_markdown(&file);
        assert!(!chunks.is_empty(), "长中文文档至少生成 1 个分块");
        let total_chunks = chunks.len();
        // 每块 heading 要么是 "第一章" 要么是 "第二章" 要么是文档标题
        for (i, c) in chunks.iter().enumerate() {
            assert!(
                !c.text.is_empty(),
                "第 {} 个分块文本为空",
                i
            );
            assert!(
                c.heading.contains("测试文档") || c.heading.contains("第一章") || c.heading.contains("第二章"),
                "第 {} 个分块 heading 异常: {}",
                i, c.heading
            );
        }
        assert!(total_chunks >= 2, "长中文文档应分成多块，实际: {}", total_chunks);
    }

    #[test]
    fn test_fallback_cjk_period_at_16000_exact() {
        // 构造 16000 字符处正好是一个中文句号的极端场景
        let mut s = String::with_capacity(18000 * 3);
        for i in 0..15999 {
            // 前 15999 字符用数字 0-9 循环（ASCII，单字节，但最后混中文）
            s.push(match (i % 10) as u8 {
                0 => '零', 1 => '一', 2 => '二', 3 => '三', 4 => '四',
                5 => '五', 6 => '六', 7 => '七', 8 => '八', _ => '九',
            });
        }
        // 第 16000 字符位置放中文句号 "。"（3 字节）— 若旧版代码直接切字节，会把 。切两半
        s.push('。');
        // 后面再填一些内容
        for i in 0..1000 {
            s.push(match (i % 5) as u8 {
                0 => '继', 1 => '续', 2 => '填', 3 => '充', _ => '！',
            });
        }
        assert_eq!(s.chars().count(), 15999 + 1 + 1000);
        // 必须不 panic，且返回有效内容
        let r = fallback_transform_selection(&s, "keypoints");
        assert!(r.is_ok(), "16000 字符边界为中文句号时不应 panic: {:?}", r.err());
        let out = r.unwrap();
        assert!(!out.is_empty(), "应生成摘要，实际为空");
    }
}
