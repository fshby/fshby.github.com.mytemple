// frontmatter.rs — Markdown frontmatter 解析与规范化
// 对应 server/frontmatter.js，纯函数实现，不持有可变状态。
// 企业级编辑器标准：frontmatter 是文档元数据的唯一可信来源，
// 解析时必须保留未知字段，写入时必须保证幂等性。

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

const OWNED_FIELDS: &[&str] = &[
    "schema", "title", "tags", "domain", "created", "updated", "status", "aliases",
];

static STATUS_VALUES: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| HashSet::from(["draft", "active", "archived"]));

static FRONTMATTER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)").unwrap());

static FIELD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z_][\w.-]*):\s*(.*)$").unwrap());

static LIST_ITEM_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s+-\s*(.*)$").unwrap());

static HEADING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#\s+(.+)$").unwrap());

static TRAILING_HASHES_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+#+\s*$").unwrap());

/// YAML 值：字符串、列表或空
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum YamlValue {
    Text(String),
    List(Vec<String>),
    Null,
}

impl YamlValue {
    pub fn as_str(&self) -> &str {
        match self {
            YamlValue::Text(s) => s,
            _ => "",
        }
    }
    pub fn as_list(&self) -> Option<&Vec<String>> {
        match self {
            YamlValue::List(v) => Some(v),
            _ => None,
        }
    }
}

/// frontmatter 解析结果
#[derive(Debug, Clone)]
pub struct FrontmatterParse {
    pub exists: bool,
    pub raw: String,
    pub body: String,
    pub data: BTreeMap<String, YamlValue>,
}

/// 标准化元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metadata {
    pub schema: String,
    pub title: String,
    pub tags: Vec<String>,
    pub domain: String,
    pub created: String,
    pub updated: String,
    pub status: String,
    pub aliases: Vec<String>,
}

/// frontmatter 概要
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrontmatterSummary {
    pub exists: bool,
    pub metadata: Metadata,
    pub missing: Vec<String>,
    pub standard: bool,
}

// ── 内部工具函数 ──────────────────────────────────────────

fn quote_yaml(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() {
        return r#""""#.to_string();
    }
    // 纯字母数字/下划线/连字符/斜杠/空格，且非 YAML 保留字 → 不加引号
    let is_plain = text
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-' || c == '/' || c == ' ');
    let is_reserved = matches!(
        text.to_lowercase().as_str(),
        "true" | "false" | "null" | "yes" | "no"
    ) || text.parse::<f64>().is_ok();
    if is_plain && !is_reserved {
        text.to_string()
    } else {
        serde_json::to_string(text).unwrap_or_else(|_| r#""""#.to_string())
    }
}

fn parse_scalar(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() {
        return String::new();
    }
    if (text.starts_with('"') && text.ends_with('"'))
        || (text.starts_with('\'') && text.ends_with('\''))
    {
        text[1..text.len() - 1].to_string()
    } else {
        text.to_string()
    }
}

fn parse_inline_list(value: &str) -> Option<Vec<String>> {
    let text = value.trim();
    if !text.starts_with('[') || !text.ends_with(']') {
        return None;
    }
    let inner = &text[1..text.len() - 1];
    Some(
        inner
            .split(',')
            .map(parse_scalar)
            .map(|s| s.strip_prefix('#').unwrap_or(&s).to_string())
            .filter(|s| !s.is_empty())
            .collect(),
    )
}

fn clean_list(values: &[String], max: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for v in values {
        let cleaned = v.trim().strip_prefix('#').unwrap_or(v.trim()).trim().to_string();
        if !cleaned.is_empty() && seen.insert(cleaned.clone()) {
            result.push(cleaned);
        }
    }
    result.truncate(max);
    result
}

// ── 公开 API ─────────────────────────────────────────────

/// 拆分 frontmatter，返回元数据 Map 和正文
pub fn split_frontmatter(markdown: &str) -> FrontmatterParse {
    let source = markdown;
    let caps = match FRONTMATTER_RE.captures(source) {
        Some(c) => c,
        None => {
            return FrontmatterParse {
                exists: false,
                raw: String::new(),
                body: source.to_string(),
                data: BTreeMap::new(),
            };
        }
    };
    let raw = caps.get(1).unwrap().as_str().to_string();
    let full_match = caps.get(0).unwrap();
    let body = &source[full_match.end()..];

    let lines: Vec<&str> = raw.lines().collect();
    let mut data = BTreeMap::new();
    let mut i = 0;
    while i < lines.len() {
        let field = match FIELD_RE.captures(lines[i]) {
            Some(c) => c,
            None => {
                i += 1;
                continue;
            }
        };
        let key = field.get(1).unwrap().as_str().to_string();
        let value_str = field.get(2).unwrap().as_str();

        // 尝试内联列表 [a, b, c]
        if let Some(list) = parse_inline_list(value_str) {
            data.insert(key, YamlValue::List(list));
            i += 1;
            continue;
        }
        if !value_str.trim().is_empty() {
            data.insert(key, YamlValue::Text(parse_scalar(value_str)));
            i += 1;
            continue;
        }
        // 多行列表
        let mut values = Vec::new();
        let mut cursor = i + 1;
        while cursor < lines.len() {
            if let Some(list_cap) = LIST_ITEM_RE.captures(lines[cursor]) {
                let item = parse_scalar(list_cap.get(1).unwrap().as_str());
                values.push(item.strip_prefix('#').unwrap_or(&item).to_string());
                cursor += 1;
            } else {
                break;
            }
        }
        if !values.is_empty() {
            data.insert(key, YamlValue::List(values));
            i = cursor;
        } else {
            data.insert(key, YamlValue::Null);
            i += 1;
        }
    }

    FrontmatterParse {
        exists: true,
        raw,
        body: body.to_string(),
        data,
    }
}

/// 保留非 OWNED_FIELDS 的未知字段行
fn preserve_unknown_blocks(raw: &str) -> Vec<String> {
    let lines: Vec<&str> = raw.lines().collect();
    let mut kept = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if let Some(cap) = FIELD_RE.captures(lines[i]) {
            let key = cap.get(1).unwrap().as_str().to_lowercase();
            if !OWNED_FIELDS.contains(&key.as_str()) {
                kept.push(lines[i].to_string());
                i += 1;
                continue;
            }
            // 跳过 owned field 及其子行
            i += 1;
            while i < lines.len() {
                let line = lines[i];
                if line.starts_with(' ') || !line.trim().is_empty() {
                    i += 1;
                } else {
                    break;
                }
            }
        } else {
            kept.push(lines[i].to_string());
            i += 1;
        }
    }
    // 去除尾部空行
    while kept.last().map_or(false, |s| s.trim().is_empty()) {
        kept.pop();
    }
    kept
}

/// 从文档中提取标准元数据
pub fn standard_metadata(markdown: &str, options: &MetadataOptions) -> Metadata {
    let parsed = split_frontmatter(markdown);
    let today = options
        .today
        .clone()
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());

    let heading = HEADING_RE
        .captures(&parsed.body)
        .and_then(|c| c.get(1).map(|m| m.as_str().trim().to_string()));

    let title = options
        .title
        .clone()
        .or_else(|| parsed.data.get("title").map(|v| v.as_str().to_string()))
        .or(heading)
        .unwrap_or_else(|| "未命名文档".to_string());

    let tags = clean_list(
        &options
            .tags
            .clone()
            .or_else(|| {
                parsed
                    .data
                    .get("tags")
                    .and_then(|v| v.as_list().cloned())
            })
            .unwrap_or_default(),
        20,
    );

    let aliases = clean_list(
        &options
            .aliases
            .clone()
            .or_else(|| {
                parsed
                    .data
                    .get("aliases")
                    .and_then(|v| v.as_list().cloned())
            })
            .unwrap_or_default(),
        20,
    );

    let status_candidate = options
        .status
        .clone()
        .or_else(|| parsed.data.get("status").map(|v| v.as_str().to_string()))
        .unwrap_or_else(|| "active".to_string())
        .to_lowercase();

    let domain = options
        .domain
        .clone()
        .or_else(|| parsed.data.get("domain").map(|v| v.as_str().to_string()))
        .unwrap_or_else(|| "未分类".to_string());

    let created = options
        .created
        .clone()
        .or_else(|| parsed.data.get("created").map(|v| v.as_str().to_string()))
        .unwrap_or_else(|| today.clone());

    let updated = options
        .updated
        .clone()
        .unwrap_or_else(|| today);

    Metadata {
        schema: "mytemple/v1".to_string(),
        title,
        tags,
        domain: if domain.trim().is_empty() {
            "未分类".to_string()
        } else {
            domain
        },
        created,
        updated,
        status: if STATUS_VALUES.contains(status_candidate.as_str()) {
            status_candidate
        } else {
            "active".to_string()
        },
        aliases,
    }
}

/// 元数据选项（可选覆盖）
#[derive(Debug, Clone, Default)]
pub struct MetadataOptions {
    pub today: Option<String>,
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub domain: Option<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub status: Option<String>,
    pub aliases: Option<Vec<String>>,
}

fn metadata_lines(meta: &Metadata) -> Vec<String> {
    let mut lines = vec![
        format!("schema: {}", quote_yaml(&meta.schema)),
        format!("title: {}", quote_yaml(&meta.title)),
    ];
    if meta.tags.is_empty() {
        lines.push("tags: []".to_string());
    } else {
        lines.push("tags:".to_string());
        for tag in &meta.tags {
            lines.push(format!("  - {}", quote_yaml(tag)));
        }
    }
    lines.push(format!("domain: {}", quote_yaml(&meta.domain)));
    lines.push(format!("created: {}", quote_yaml(&meta.created)));
    lines.push(format!("updated: {}", quote_yaml(&meta.updated)));
    lines.push(format!("status: {}", meta.status));
    if meta.aliases.is_empty() {
        lines.push("aliases: []".to_string());
    } else {
        lines.push("aliases:".to_string());
        for alias in &meta.aliases {
            lines.push(format!("  - {}", quote_yaml(alias)));
        }
    }
    lines
}

/// 规范化 frontmatter：提取元数据 + 保留未知字段 + 清理正文
pub fn normalize_frontmatter(markdown: &str, options: &MetadataOptions) -> String {
    let parsed = split_frontmatter(markdown);
    let metadata = standard_metadata(markdown, options);
    let unknown = if parsed.exists {
        preserve_unknown_blocks(&parsed.raw)
    } else {
        Vec::new()
    };
    let mut lines = metadata_lines(&metadata);
    if !unknown.is_empty() {
        lines.push(String::new());
        lines.extend(unknown);
    }
    let body = parsed.body.trim_start_matches(|c: char| c.is_whitespace());
    format!("---\n{}\n---\n\n{}", lines.join("\n"), body)
}

/// 创建文档模板
pub fn create_document_template(name: &str, today: Option<&str>) -> String {
    let date = today
        .map(|s| s.to_string())
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());
    let title = if name.trim().is_empty() {
        "未命名文档"
    } else {
        name.trim()
    };
    normalize_frontmatter(
        &format!("# {}\n\n", title),
        &MetadataOptions {
            title: Some(title.to_string()),
            tags: Some(vec![]),
            domain: Some("未分类".to_string()),
            created: Some(date.clone()),
            updated: Some(date),
            status: Some("draft".to_string()),
            ..Default::default()
        },
    )
}

/// frontmatter 概要检查
pub fn frontmatter_summary(markdown: &str) -> FrontmatterSummary {
    let parsed = split_frontmatter(markdown);
    let metadata = standard_metadata(markdown, &MetadataOptions::default());
    let missing: Vec<String> = OWNED_FIELDS
        .iter()
        .filter(|field| !parsed.data.contains_key(**field))
        .map(|s| s.to_string())
        .collect();
    let standard = parsed.exists
        && missing.is_empty()
        && parsed
            .data
            .get("schema")
            .map_or(false, |v| v.as_str() == "mytemple/v1");
    FrontmatterSummary {
        exists: parsed.exists,
        metadata,
        missing,
        standard,
    }
}

/// 规范化 Markdown 内容：统一换行符、合并多余空行、确保标题 `#` 后有空格
pub fn normalize_markdown(text: &str) -> String {
    let mut result = text.to_string();

    // 统一换行符
    result = result.replace("\r\n", "\n").replace("\r", "\n");

    // 确保末尾只有一个换行
    result = result.trim_end().to_string();
    result.push('\n');

    // 将 3+ 连续空行压缩为 2 个空行
    let multi_blank = regex::Regex::new(r"\n{3,}").unwrap();
    result = multi_blank.replace_all(&result, "\n\n").to_string();

    // 确保标题 `#` 后有空格
    let heading_re = regex::Regex::new(r"^(#+)([^#\s])").unwrap();
    result = heading_re.replace_all(&result, |caps: &regex::Captures| {
        format!("{} {}", &caps[1], &caps[2])
    }).to_string();

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_frontmatter_basic() {
        let md = "---\ntitle: Hello\n---\n\n# Hello\nWorld";
        let parsed = split_frontmatter(md);
        assert!(parsed.exists);
        assert_eq!(parsed.data.get("title").unwrap().as_str(), "Hello");
        assert!(parsed.body.contains("World"));
    }

    #[test]
    fn test_no_frontmatter() {
        let md = "# No frontmatter\nHello";
        let parsed = split_frontmatter(md);
        assert!(!parsed.exists);
        assert_eq!(parsed.body, md);
    }

    #[test]
    fn test_create_template() {
        let tpl = create_document_template("Test", Some("2026-01-01"));
        assert!(tpl.contains("title: Test"));
        assert!(tpl.contains("status: draft"));
        assert!(tpl.starts_with("---\n"));
    }

    #[test]
    fn test_normalize_preserves_unknown() {
        let md = "---\ntitle: Test\nauthor: Alice\n---\n\nHello";
        let normalized = normalize_frontmatter(md, &MetadataOptions::default());
        assert!(normalized.contains("author: Alice"));
        assert!(normalized.contains("title: Test"));
    }

    #[test]
    fn test_list_tags() {
        let md = "---\ntags:\n  - rust\n  - crypto\n---\n\nHello";
        let parsed = split_frontmatter(md);
        let tags = parsed.data.get("tags").unwrap().as_list().unwrap();
        assert_eq!(tags, &vec!["rust", "crypto"]);
    }
}
