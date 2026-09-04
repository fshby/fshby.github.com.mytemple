// utils.rs — 纯工具函数与知识图谱构建器
// 对应 server/utils.js，不持有模块级可变状态，仅依赖入参。
// 企业级编辑器标准：文件安全检查必须使用路径规范化防止穿越攻击，
// 图谱构建必须支持大规模裁剪（MAX_GRAPH_NODES=1200）。

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

// ── 文件大小格式化 ────────────────────────────────────────

pub fn format_file_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

// ── 路径安全检查 ──────────────────────────────────────────

/// 检查 absolute 是否在 root 内部（防止路径穿越）
pub fn is_inside(root: &Path, absolute: &Path) -> bool {
    let root_canon = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let abs_canon = std::fs::canonicalize(absolute).unwrap_or_else(|_| absolute.to_path_buf());
    abs_canon.starts_with(&root_canon)
}

/// 转义正则特殊字符
pub fn escape_regex(value: &str) -> String {
    let escaped = regex::escape(value);
    escaped
}

// ── 工作区 ID 生成 ────────────────────────────────────────

/// 根据工作区根路径生成唯一 ID
pub fn workspace_id(root: &Path) -> String {
    let normalized = root
        .to_string_lossy()
        .to_lowercase()
        .replace('\\', "/");
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let hash = hasher.finalize();
    let hex: String = hash.iter().take(5).map(|b| format!("{:02x}", b)).collect();
    format!("ws_{}", hex)
}

/// 工作区引用：ws_id:relative_path
pub fn workspace_ref(id: &str, relative: &str) -> String {
    format!("{}:{}", id, relative)
}

// ── 文档索引提取 ──────────────────────────────────────────

static HEADING_MATCH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(#{1,6})\s+(.+?)\s*$").unwrap());

static TRAILING_HASH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+#+\s*$").unwrap());

/// 提取文档标题大纲（H1-H6），最多 32 条
pub fn extract_index_headings(content: &str) -> Vec<IndexHeading> {
    HEADING_MATCH_RE
        .captures_iter(content)
        .take(32)
        .map(|cap| {
            let level = cap.get(1).unwrap().as_str().len();
            let title = TRAILING_HASH_RE
                .replace(cap.get(2).unwrap().as_str(), "")
                .trim()
                .to_string();
            IndexHeading {
                level: level as u8,
                title,
            }
        })
        .filter(|h| !h.title.is_empty())
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexHeading {
    pub level: u8,
    pub title: String,
}

// ── 文档摘要提取 ──────────────────────────────────────────

static FRONTMATTER_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^---\s*\r?\n.*?\r?\n---\s*$").unwrap());

static CODE_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)```.*?```").unwrap());

static IMG_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]+\)").unwrap());

static TEXT_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\]]+)\]\([^)]+\)").unwrap());

static WIKI_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]").unwrap());

static HEADING_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s{0,3}#{1,6}\s+").unwrap());

static MARKDOWN_SYNTAX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[*_`>#~-]+").unwrap());

/// 创建文档摘要：去除 Markdown 语法，截取前 limit 字符
pub fn create_index_excerpt(content: &str, limit: usize) -> String {
    let text = FRONTMATTER_BLOCK_RE.replace_all(content, " ");
    let text = CODE_BLOCK_RE.replace_all(&text, " ");
    let text = IMG_LINK_RE.replace_all(&text, " ");
    let text = TEXT_LINK_RE.replace_all(&text, "$1");
    let text = WIKI_LINK_RE.replace_all(&text, "$1");
    let text = HEADING_PREFIX_RE.replace_all(&text, "");
    let text = MARKDOWN_SYNTAX_RE.replace_all(&text, " ");
    let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.len() > limit {
        let mut end = limit;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &text[..end])
    } else {
        text
    }
}

// ── 图谱构建 ─────────────────────────────────────────────

static WIKI_LINK_GRAPH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\[\[([^\]]+)\]\]|\]\(([^)]+\.md(?:#[^)]+)?)\)").unwrap());

/// 图谱节点
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub kind: String, // doc | tag | keyword | missing
    pub group: String,
    pub weight: f64,
    pub modified: u64,
    #[serde(default)]
    pub degree: u32,
    #[serde(default)]
    pub orphan: bool,
}

/// 图谱边
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    #[serde(rename = "type")]
    pub edge_type: String, // link | missing | tag | keyword
    pub weight: f64,
    pub directed: bool,
}

/// 图谱统计
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphStats {
    pub documents: usize,
    pub nodes: usize,
    pub edges: usize,
    #[serde(default)]
    pub pruned: bool,
}

/// 完整图谱
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub stats: GraphStats,
}

/// 文件信息（图谱构建输入）
#[derive(Debug, Clone)]
pub struct GraphFile {
    pub path: String,
    pub relative: String,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub terms: Vec<TermCount>,
    pub workspace_id: String,
    pub workspace_name: Option<String>,
    pub modified: u64,
}

#[derive(Debug, Clone)]
pub struct TermCount {
    pub term: String,
    pub count: u32,
}

/// 图谱投影（双向链接、反向链接、概念、缺失链接）
#[derive(Debug, Clone)]
pub struct GraphProjection {
    pub version: u32,
    pub outgoing_links: HashMap<String, HashSet<String>>,
    pub backlinks: HashMap<String, HashSet<String>>,
    pub concepts: HashMap<String, HashSet<String>>,
    pub missing_links: HashMap<String, HashSet<String>>,
}

/// 构建知识图谱
pub fn build_graph(files: &[GraphFile]) -> Graph {
    // 上限 1200 → 2400：原 1200 太低，中等规模工作区（数百文档 + 标签 + 关键词 + missing）
    // 就会触发裁剪导致部分文档不显示。前端 pixelBudget 也有 >600 自适应分档。
    let max_graph_nodes = 2400;

    // 索引映射
    let by_base: HashMap<String, &GraphFile> = files
        .iter()
        .map(|f| {
            let base = Path::new(&f.relative)
                .file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            (base, f)
        })
        .collect();

    let by_workspace_base: HashMap<String, &GraphFile> = files
        .iter()
        .map(|f| {
            let base = Path::new(&f.relative)
                .file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            (format!("{}:{}", f.workspace_id, base), f)
        })
        .collect();

    let by_path: HashMap<String, &GraphFile> = files
        .iter()
        .map(|f| (f.path.to_lowercase(), f))
        .collect();

    // 创建文档节点
    let mut nodes: Vec<GraphNode> = files
        .iter()
        .map(|f| GraphNode {
            id: f.path.clone(),
            label: f.title.clone(),
            kind: "doc".to_string(),
            group: f.workspace_name.clone().unwrap_or_else(|| f.workspace_id.clone()),
            weight: 1.0,
            modified: f.modified,
            degree: 0,
            orphan: false,
        })
        .collect();

    let mut node_ids: HashSet<String> = files.iter().map(|f| f.path.clone()).collect();
    let mut edge_map: HashMap<String, GraphEdge> = HashMap::new();

    let mut add_node = |nodes: &mut Vec<GraphNode>, node_ids: &mut HashSet<String>, node: GraphNode| -> bool {
        if node_ids.contains(&node.id) {
            return false;
        }
        node_ids.insert(node.id.clone());
        nodes.push(node);
        true
    };

    let mut add_edge = |edge_map: &mut HashMap<String, GraphEdge>, source: &str, target: &str, edge_type: &str, weight: f64, directed: bool| {
        if source.is_empty() || target.is_empty() || source == target {
            return;
        }
        let pair = if directed {
            format!("{}|{}", source, target)
        } else {
            let mut pair = vec![source.to_string(), target.to_string()];
            pair.sort();
            pair.join("|")
        };
        let key = format!("{}|{}", pair, edge_type);
        edge_map
            .entry(key)
            .and_modify(|e| e.weight += weight)
            .or_insert(GraphEdge {
                source: source.to_string(),
                target: target.to_string(),
                edge_type: edge_type.to_string(),
                weight,
                directed,
            });
    };

    // 1. 解析 wiki 链接和 Markdown 链接
    let mut missing_count: usize = 0;
    for file in files {
        for cap in WIKI_LINK_GRAPH_RE.captures_iter(&file.content) {
            let raw = cap
                .get(1)
                .or(cap.get(2))
                .map(|m| m.as_str())
                .unwrap_or("");
            let raw = raw.split('|').next().unwrap_or("").split('#').next().unwrap_or("").trim().replace('\\', "/");
            if raw.is_empty() {
                continue;
            }
            let raw_with_ext = if raw.to_lowercase().ends_with(".md") {
                raw.clone()
            } else {
                format!("{}.md", raw)
            };
            let raw_base = Path::new(&raw_with_ext)
                .file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            // 尝试匹配
            let base_target = by_workspace_base
                .get(&format!("{}:{}", file.workspace_id, raw_base))
                .or_else(|| by_base.get(&raw_base));
            let rel_dir = Path::new(&file.relative).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
            let relative_target = normalize_posix_path(&format!("{}/{}", rel_dir, raw_with_ext));
            let path_target = by_path.get(&workspace_ref(&file.workspace_id, &relative_target).to_lowercase());

            let target = path_target.or(base_target);
            if let Some(t) = target {
                add_edge(&mut edge_map, &file.path, &t.path, "link", 3.0, true);
            } else {
                let missing_id = format!("missing:{}:{}", file.workspace_id, raw.to_lowercase());
                if !node_ids.contains(&missing_id) && missing_count < 120 {
                    let label = Path::new(&raw).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or(raw.clone());
                    if add_node(&mut nodes, &mut node_ids, GraphNode {
                        id: missing_id.clone(),
                        label,
                        kind: "missing".to_string(),
                        group: "未创建".to_string(),
                        weight: 1.0,
                        modified: 0,
                        degree: 0,
                        orphan: false,
                    }) {
                        missing_count += 1;
                    }
                }
                add_edge(&mut edge_map, &file.path, &missing_id, "missing", 2.0, true);
            }
        }
    }

    // 2. 标签节点
    let mut tag_file_map: HashMap<String, Vec<&GraphFile>> = HashMap::new();
    for file in files {
        for tag in &file.tags {
            tag_file_map.entry(tag.clone()).or_default().push(file);
        }
    }
    let mut top_tags: Vec<_> = tag_file_map.iter().collect();
    top_tags.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    top_tags.truncate(160);
    for (tag, tag_files) in top_tags {
        let tag_id = format!("tag:{}", tag);
        add_node(&mut nodes, &mut node_ids, GraphNode {
            id: tag_id.clone(),
            label: format!("#{}", tag),
            kind: "tag".to_string(),
            group: "标签".to_string(),
            weight: tag_files.len() as f64,
            modified: 0,
            degree: 0,
            orphan: false,
        });
        for file in tag_files {
            add_edge(&mut edge_map, &file.path, &tag_id, "tag", 2.0, false);
        }
    }

    // 3. 关键词节点（TF-IDF 启发式评分）
    let mut term_file_map: HashMap<String, Vec<(&GraphFile, u32)>> = HashMap::new();
    for file in files {
        for item in file.terms.iter().take(10) {
            if item.term.chars().all(|c| c.is_ascii_digit()) || item.term.len() < 2 {
                continue;
            }
            term_file_map
                .entry(item.term.clone())
                .or_default()
                .push((file, item.count));
        }
    }

    let keyword_limit = (files.len() as f64).sqrt().ceil() as usize * 3;
    let keyword_limit = keyword_limit.clamp(12, 48);
    let max_hits = (files.len() as f64 * 0.45).ceil() as usize;
    let mut candidates: Vec<(String, Vec<(&GraphFile, u32)>, f64)> = Vec::new();
    for (term, hits) in &term_file_map {
        if hits.len() < 2 || hits.len() > max_hits.max(12) {
            continue;
        }
        let mut score = ((files.len() as f64 + 1.0) / (hits.len() as f64 + 1.0)).ln() + 1.0;
        score *= hits.iter().map(|(_, c)| (1.0 + *c as f64).log2()).sum::<f64>();
        score *= 1.0 + (1.0 + hits.len() as f64).log2() * 0.35;
        candidates.push((term.clone(), hits.clone(), score));
    }
    candidates.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    candidates.truncate(keyword_limit);

    let mut semantic_degree: HashMap<String, u32> = HashMap::new();
    for (term, hits, _) in candidates {
        let mut sorted_hits = hits.clone();
        sorted_hits.sort_by(|a, b| b.1.cmp(&a.1));
        let selected: Vec<_> = sorted_hits
            .into_iter()
            .filter(|(f, _)| *semantic_degree.get(&f.path).unwrap_or(&0) < 5)
            .take(10)
            .collect();
        if selected.len() < 2 {
            continue;
        }
        let keyword_id = format!("keyword:{}", term);
        let weight: u32 = selected.iter().map(|(_, c)| *c).sum();
        add_node(&mut nodes, &mut node_ids, GraphNode {
            id: keyword_id.clone(),
            label: term.clone(),
            kind: "keyword".to_string(),
            group: "语义".to_string(),
            weight: weight as f64,
            modified: 0,
            degree: 0,
            orphan: false,
        });
        for (file, count) in &selected {
            let w = (*count as f64).clamp(1.0, 6.0);
            add_edge(&mut edge_map, &file.path, &keyword_id, "keyword", w, false);
            *semantic_degree.entry(file.path.clone()).or_insert(0) += 1;
        }
    }

    // 排序边并裁剪
    let edge_order = |t: &str| -> u8 {
        match t {
            "link" => 0,
            "missing" => 1,
            "tag" => 2,
            "keyword" => 3,
            _ => 9,
        }
    };
    let edge_limit = (files.len() * 8).clamp(240, 2400);
    let mut edges: Vec<GraphEdge> = edge_map.into_values().collect();
    edges.sort_by(|a, b| {
        edge_order(&a.edge_type)
            .cmp(&edge_order(&b.edge_type))
            .then_with(|| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal))
    });
    edges.truncate(edge_limit);

    // 计算节点度数
    let mut degree: HashMap<String, u32> = HashMap::new();
    for e in &edges {
        *degree.entry(e.source.clone()).or_insert(0) += 1;
        *degree.entry(e.target.clone()).or_insert(0) += 1;
    }
    for node in &mut nodes {
        node.degree = *degree.get(&node.id).unwrap_or(&0);
        node.orphan = node.kind == "doc" && node.degree == 0;
        node.weight = node.weight.max(1.0 + node.degree as f64);
    }

    // 大规模图谱裁剪
    // 修复：原逻辑按 degree 排序保留高度数 doc，裁掉低度数 doc —— 恰恰是用户看不到"部分文档"的根因。
    // 新策略：优先保留所有 doc 节点（用户真正关心的），只裁剪 tag/keyword/missing 辅助节点。
    if nodes.len() > max_graph_nodes {
        let mut doc_nodes: Vec<GraphNode> = Vec::new();
        let mut aux_nodes: Vec<GraphNode> = Vec::new();  // tag/keyword/missing 辅助节点
        for n in nodes.into_iter() {
            if n.kind == "doc" {
                doc_nodes.push(n);
            } else {
                aux_nodes.push(n);
            }
        }
        // 辅助节点按 weight（频次/重要度）降序排，保留 weight 最高的
        aux_nodes.sort_by(|a, b| {
            b.weight
                .partial_cmp(&a.weight)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.degree.cmp(&a.degree))
        });
        // doc 全保留，辅助节点只填剩余配额
        let aux_keep = max_graph_nodes.saturating_sub(doc_nodes.len());
        let kept_ids: HashSet<String> = doc_nodes
            .iter()
            .map(|n| n.id.clone())
            .chain(aux_nodes.iter().take(aux_keep).map(|n| n.id.clone()))
            .collect();
        let trimmed_edges: Vec<GraphEdge> = edges
            .iter()
            .filter(|e| kept_ids.contains(&e.source) || kept_ids.contains(&e.target))
            .cloned()
            .collect();
        let mut trimmed_nodes = doc_nodes;
        trimmed_nodes.extend(aux_nodes.into_iter().take(aux_keep));

        // 重新计算度数
        let mut new_degree: HashMap<String, u32> = HashMap::new();
        for e in &trimmed_edges {
            *new_degree.entry(e.source.clone()).or_insert(0) += 1;
            *new_degree.entry(e.target.clone()).or_insert(0) += 1;
        }
        for node in &mut trimmed_nodes {
            node.degree = *new_degree.get(&node.id).unwrap_or(&0);
            node.orphan = node.kind == "doc" && node.degree == 0;
            node.weight = node.weight.max(1.0 + node.degree as f64);
        }

        return Graph {
            nodes: trimmed_nodes,
            edges: trimmed_edges,
            stats: GraphStats {
                documents: files.len(),
                nodes: 0,
                edges: 0,
                pruned: true,
            },
        };
    }

    let node_count = nodes.len();
    let edge_count = edges.len();
    Graph {
        nodes,
        edges,
        stats: GraphStats {
            documents: files.len(),
            nodes: node_count,
            edges: edge_count,
            pruned: false,
        },
    }
}

/// POSIX 路径规范化（不使用 std::path，保持与 JS 版本一致）
fn normalize_posix_path(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in p.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

// ── 语义标签正则缓存（ST_ 前缀避免与模块其他重名） ──────

static ST_HASHTAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#([\p{L}\p{N}_-]{1,30})").unwrap());

static ST_HEADING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^#{1,6}\s+(.+?)\s*$").unwrap());

static ST_WIKI_FULL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\[\]|#]+?)(?:#[^\[\]|]*?)?(?:\|([^\[\]]+?))?\]\]").unwrap());

static ST_BOLD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*\*([^*\r\n]{1,40})\*\*").unwrap());

static ST_LINKTEXT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\[\]\r\n]{1,60})\]\([^)]+\)").unwrap());

static ST_FM_TAGS_ARR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*(?:tags|keywords|categories)\s*:\s*\[([^\]]*)\]").unwrap());

static ST_FM_KV_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*(domain|topic|category)\s*:\s*(.+?)\s*$").unwrap());

static ST_WORD_TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]{2,}").unwrap());

static ST_INLINECODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"`[^`\r\n]*`").unwrap());

/// 从文本中提取语义标签（增强版启发式）
///
/// 提取顺序：
/// 1. Frontmatter 中 tags/keywords/categories（数组）、domain/topic/category（单值）
/// 2. [[Wiki 链接]]（含别名与目标名，支持 [[目标#锚|别名]]）
/// 3. #hashtag（中英文数字、下划线、连字符）
/// 4. **加粗内容**（短的直接作为标签，长的抽取 token）
/// 5. [链接文字](URL) 中的链接文字
/// 6. Markdown 标题关键词（中文 ≥ 2 字，英文 ≥ 3 字）
///
/// 去重，最多返回 24 个标签
pub fn extract_semantic_tags(text: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // 先剥离代码块和内联代码，避免代码内符号被误识别为标签
    let no_code_blocks = CODE_BLOCK_RE.replace_all(text, " ");
    let no_inline = ST_INLINECODE_RE.replace_all(&no_code_blocks, " ");
    let clean_text = no_inline.as_ref();

    // 规范化 + 去重的 push 辅助闭包
    let mut insert_tag = |raw: &str| {
        let t = raw.trim().trim_matches(|c: char| c == '"' || c == '\'' || c == '，' || c == '。');
        if t.is_empty() || t.chars().count() < 2 || t.len() > 40 {
            return;
        }
        // 清理两侧非字母数字字符（但保留 _ - ）
        let cleaned: String = t
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || !c.is_ascii_punctuation())
            .collect();
        let trimmed = cleaned.trim_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '-');
        if trimmed.is_empty() || trimmed.chars().count() < 2 {
            return;
        }
        let key = trimmed.to_lowercase();
        if seen.insert(key.clone()) {
            tags.push(key);
        }
    };

    // ── 1. Frontmatter tags / keywords / categories 数组 ──
    for cap in ST_FM_TAGS_ARR_RE.captures_iter(text) {
        if let Some(list_m) = cap.get(1) {
            for item in list_m.as_str().split(',') {
                insert_tag(item);
            }
        }
    }
    //    单值形式 domain / topic / category
    for cap in ST_FM_KV_RE.captures_iter(text) {
        if let Some(val) = cap.get(2) {
            insert_tag(val.as_str());
        }
    }

    // ── 2. [[Wiki Link]] ──────────────────────────────────
    for cap in ST_WIKI_FULL_RE.captures_iter(clean_text) {
        if let Some(alias) = cap.get(2) {
            insert_tag(alias.as_str());
        }
        if let Some(target) = cap.get(1) {
            insert_tag(target.as_str());
        }
    }

    // ── 3. #hashtag ───────────────────────────────────────
    for cap in ST_HASHTAG_RE.captures_iter(clean_text) {
        if let Some(m) = cap.get(1) {
            insert_tag(m.as_str());
        }
    }

    // ── 4. **加粗关键词** ─────────────────────────────────
    for cap in ST_BOLD_RE.captures_iter(clean_text) {
        if let Some(m) = cap.get(1) {
            let content = m.as_str().trim();
            if content.chars().count() <= 14 {
                insert_tag(content);
            } else {
                for tok in ST_WORD_TOKEN_RE.find_iter(content) {
                    insert_tag(tok.as_str());
                }
            }
        }
    }

    // ── 5. Markdown 链接文字 ──────────────────────────────
    for cap in ST_LINKTEXT_RE.captures_iter(clean_text) {
        if let Some(m) = cap.get(1) {
            let txt = m.as_str().trim();
            if txt.chars().count() <= 16 {
                insert_tag(txt);
            } else {
                for tok in ST_WORD_TOKEN_RE.find_iter(txt) {
                    insert_tag(tok.as_str());
                }
            }
        }
    }

    // ── 6. 标题中的中英文关键词 ────────────────────────────
    for cap in ST_HEADING_RE.captures_iter(clean_text) {
        if let Some(heading_m) = cap.get(1) {
            for tok in ST_WORD_TOKEN_RE.find_iter(heading_m.as_str().trim()) {
                let s = tok.as_str();
                // 判断是否包含 CJK 字符
                let has_cjk = s.chars().any(|c| {
                    let cp = c as u32;
                    (0x4E00..=0x9FFF).contains(&cp)
                        || (0x3400..=0x4DBF).contains(&cp)
                        || (0xF900..=0xFAFF).contains(&cp)
                });
                let ok = if has_cjk { s.chars().count() >= 2 } else { s.chars().count() >= 3 };
                if ok {
                    insert_tag(s);
                }
            }
        }
    }

    tags.truncate(24);
    tags
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_file_size() {
        assert_eq!(format_file_size(512), "512 B");
        assert_eq!(format_file_size(2048), "2.0 KB");
        assert_eq!(format_file_size(1048576), "1.0 MB");
    }

    #[test]
    fn test_extract_headings() {
        let content = "# Title\n\n## Section\n\n### Sub\n\ntext";
        let headings = extract_index_headings(content);
        assert_eq!(headings.len(), 3);
        assert_eq!(headings[0].level, 1);
        assert_eq!(headings[0].title, "Title");
    }

    #[test]
    fn test_create_excerpt() {
        let content = "---\ntitle: Test\n---\n\n# Hello\n\nThis is **bold** text.";
        let excerpt = create_index_excerpt(content, 320);
        assert!(excerpt.contains("Hello"));
        assert!(!excerpt.contains("---"));
        assert!(!excerpt.contains("**"));
    }

    #[test]
    fn test_workspace_id() {
        let id1 = workspace_id(Path::new("C:/Users/test/docs"));
        let id2 = workspace_id(Path::new("C:/Users/test/docs"));
        assert_eq!(id1, id2);
        assert!(id1.starts_with("ws_"));
    }

    #[test]
    fn test_extract_semantic_tags_enhanced() {
        let sample = "---\ntitle: 规范\ntags: [\"知识管理\", \"Markdown\"]\ndomain: 文档工程\n---\n\n# 企业级 写作指南\n\n**文档结构**、[[标签系统|标签管理]]、[[AI摘要]]。\n\n参考 [官方文档](https://x.com)。\n\n## 组织原则\n\n#标签A #标签B。";
        let tags = extract_semantic_tags(sample);
        // 至少提取到一类特征
        let any = tags.iter().any(|t| {
            t == "知识管理"
                || t == "markdown"
                || t == "文档工程"
                || t == "标签管理"
                || t == "标签系统"
                || t == "ai摘要"
                || t == "文档结构"
                || t == "官方文档"
                || t == "标签a"
                || t == "标签b"
                || t == "写作指南"
                || t == "企业级"
        });
        assert!(any, "至少应识别一类标签，实际: {:?}", tags);
    }
}
