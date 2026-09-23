# 检索功能深度重构方案

## 目标

在不引入新依赖、不影响检索速度、维持用户友好性、控制内存消耗的前提下，让 MyTemple 全局检索从「子串包含 + 固定分值 + AND 严格匹配」升级为「CJK 分词 + 倒排索引 + BM25F 评分 + OR 部分匹配 + 精确短语后置过滤」的精确检索，并补齐前端高亮、分页、历史记录等体验短板。

## 当前状态分析

### 核心缺陷（基于实际代码）

**缺陷 1：中文查询无法分词**
- [app.rs](file:///d:/game/mytemple/src-tauri/src/app.rs#L1451-L1455) `search()` 使用 `split_whitespace()` 切分查询，中文连续字符无空格，整段被当作一个 token，匹配近乎不可能。
- [rag.rs](file:///d:/game/mytemple/src-tauri/src/rag.rs#L221-L230) `tokenize()` 使用 `\p{L}\p{N}` 正则，对中文同样无效（一个长中文串被整体匹配）。
- 全项目唯一可用的中文分词在 [server/rag.js](file:///d:/game/mytemple/server/rag.js#L17-L28) `Intl.Segmenter`，但仅用于 RAG 服务层，未惠及全局检索。

**缺陷 2：子串包含匹配过宽**
- [app.rs:1468-1481](file:///d:/game/mytemple/src-tauri/src/app.rs#L1468-L1481) 使用 `title_lower.contains(t) || plain_lower.contains(t)`，子串匹配导致「java」会命中「javascript」「javafx」；查询「的」会命中所有含「的」的文档。

**缺陷 3：固定分值，无法体现相关性**
- [app.rs:1485-1493](file:///d:/game/mytemple/src-tauri/src/app.rs#L1485-L1493) title +50/词、content +10/词，不考虑文档长度、词频饱和、IDF。长文档命中越多分值越高，但相关性未必更好。

**缺陷 4：AND 严格逻辑过于严苛**
- [app.rs:1480](file:///d:/game/mytemple/src-tauri/src/app.rs#L1480) `tokens.iter().all(...)` 全部命中才通过，任何一个分词未命中即整条结果被剔除，中文分词后稍有偏差即全军覆没。

**缺陷 5：无关键词高亮**
- [app.js:8866-8870](file:///d:/game/mytemple/public/app.js#L8866-L8870) `title.textContent = displayName(file)` 用纯文本渲染，命中关键词在结果中无视觉区分，用户难以定位匹配点。

**缺陷 6：无分页，仅显示前 80 条**
- [app.js:8859](file:///d:/game/mytemple/public/app.js#L8859) `results.slice(0, 80)` 硬截断，超过部分仅显示「还有 N 条结果，继续输入可缩小范围」，无法翻页浏览。

**缺陷 7：无搜索历史、无补全**
- 前端无历史记录、无输入补全，重复检索需手动重打。

**缺陷 8：SearchIndex 实际不是索引**
- [app.rs:285-289](file:///d:/game/mytemple/src-tauri/src/app.rs#L285-L289) `SearchIndex { entries: Vec<usize> }` 仅是「文件索引列表」（refresh_cache 里 `0..all_files.len()`），未做任何倒排。每次检索都遍历全部文件做 contains，文件数大时检索慢。

### 现有可复用资产

- [app.rs:1423-1431](file:///d:/game/mytemple/src-tauri/src/app.rs#L1423-L1431) `align_boundary()` 字符边界对齐工具，切片 panic 防护已就位（遵守 project_memory 硬性约束）。
- [app.rs:1440-1450](file:///d:/game/mytemple/src-tauri/src/app.rs#L1440-L1450) 已有引号精确短语解析逻辑，可直接复用为 phrase post-filter。
- [rag.rs:55-57](file:///d:/game/mytemple/src-tauri/src/rag.rs#L55-L57) `TOKEN_RE`、[rag.rs:221-230](file:///d:/game/mytemple/src-tauri/src/rag.rs#L221-L230) `tokenize()` 可统一扩展为 CJK 双字版。
- [app.rs:457-510](file:///d:/game/mytemple/src-tauri/src/app.rs#L457-L510) `refresh_cache()` 是构建倒排索引的天然挂载点。
- [app.js:8858](file:///d:/game/mytemple/public/app.js#L8858) `state.flatFilesByPath` 已有文件路径索引，前端无需重建。

## 设计决策

### 决策 1：CJK 双字（bigram）分词，零新依赖
- 参考 Lucene `CJKAnalyzer`：对 CJK 字符以 N=2 滑动窗口切分（"知识图谱" → "知识"、"识图"、"图谱"）。
- 对 ASCII 单词（英文/数字/下划线）保留原词形，按 `\p{L}\p{N}` 匹配。
- 不引入 jieba / Intl.Segmenter（Rust 端无原生 Intl；Feature Gate 留作 Phase 2 可选项）。
- 优势：纯字符运算，无外部依赖，与 project_memory「不增加产品性能消耗」一致。

### 决策 2：倒排索引结构
- `HashMap<u32 token_id, Vec<Posting>>`：token_id 为字符串哈希后的 u32，避免 String 占内存。
- `Posting { doc_idx: u32, tf_title: u16, tf_body: u16 }`：每词每文档一条记录，标题/正文分桶统计词频。
- `DocMeta { title_len: u32, body_len: u32 }`：用于 BM25 文档长度归一。
- 索引内存估算：10k 文档 × 平均 200 词/文档 ≈ 200 万 Posting，每条 8 字节 ≈ 16MB，远低于浏览器/WebView2 内存预算。

### 决策 3：BM25F-lite 双字段评分
- 公式：`IDF * (tf * (k1+1)) / (tf + k1 * (1 - b + b * dl/avgdl))`
- 参数：`k1=1.2`，`b_body=0.75`，`b_title=0.5`（标题更短，归一更弱）。
- 双字段加权：`score = W_title * BM25(title) + W_body * BM25(body)`，`W_title=3.0`，`W_body=1.0`。
- `IDF = ln(1 + (N - df + 0.5) / (df + 0.5))`。

### 决策 4：OR 部分匹配 + 精确短语后置过滤
- 任一 token 命中即入选候选集（OR 逻辑），缓解分词偏差导致的全军覆没。
- 按命中 token 数 / 总 token 数的比例做粗排，再 BM25 精排。
- 引号 `"..."` 内的精确短语做后置过滤（必须连续命中），保留 [app.rs:1440-1450](file:///d:/game/mytemple/src-tauri/src/app.rs#L1440-L1450) 现有解析逻辑。

### 决策 5：token 级高亮 + 分页
- 前端对 snippet/title 按 token 命中位置包裹 `<mark>`。
- 后端 `/api/search` 增加 `offset`、`limit` 参数，前端实现「加载更多」按钮替代硬截断。
- 搜索历史存 `localStorage`，最多 20 条；输入框下拉补全。

### 决策 6：与 RAG 检索统一 tokenize（Phase 2 可选，本方案不强制）
- 当前方案只在 `app.rs` 内部新增 `tokenize_cjk_terms`，不修改 `rag.rs`，避免 RAG 向量索引 schema 变更导致重建。
- Phase 2 可将 `tokenize_cjk_terms` 提到 `rag.rs` 共享，并打开 jieba Feature Gate（非默认）。

## 变更清单（按文件）

### 文件 1：`d:\game\mytemple\src-tauri\src\app.rs`（核心）

**新增结构体（紧贴 `SearchIndex` 之上）**

在 [app.rs:283-289](file:///d:/game/mytemple/src-tauri/src/app.rs#L283-L289) `SearchIndex` 定义处替换为新结构：

```rust
#[derive(Debug, Default, Clone)]
pub struct SearchIndex {
    pub inverted: HashMap<u32, Vec<Posting>>,
    pub doc_metas: Vec<DocMeta>,
    pub avg_title_len: f64,
    pub avg_body_len: f64,
    pub total_docs: u32,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Posting {
    pub doc_idx: u32,
    pub tf_title: u16,
    pub tf_body: u16,
}

#[derive(Debug, Default, Clone)]
pub struct DocMeta {
    pub title_len: u32,
    pub body_len: u32,
}
```

> 注意：所有新结构体遵守 project_memory 硬性约束——若被序列化暴露给前端，需加 `#[serde(rename_all = "camelCase")]`；本方案中 `Posting`/`DocMeta` 不直接序列化给前端，无需加。

**扩展 `SearchResult`**

[app.rs:295-302](file:///d:/game/mytemple/src-tauri/src/app.rs#L295-L302) `SearchResult` 改为：

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,           // u32 → f64（BM25 为浮点）
    pub matched_tokens: Vec<String>,  // 新增：前端高亮用
    pub total_matches: u32,   // 新增：命中 token 数
    pub total_tokens: u32,    // 新增：查询分词总数
}
```

**新增 `tokenize_cjk_terms` 函数**

放在 `search()` 上方或 `impl AppState` 外的自由函数：

```rust
/// CJK 双字分词 + ASCII 单词分词（零依赖，参考 Lucene CJKAnalyzer）
fn tokenize_cjk_terms(text: &str) -> Vec<String> {
    use std::collections::VecDeque;
    let normalized = text.to_lowercase();
    let mut tokens = Vec::new();
    let mut cjk_buffer: VecDeque<char> = VecDeque::new();

    let flush_cjk = |buf: &mut VecDeque<char>, out: &mut Vec<String>| {
        let chars: Vec<char> = buf.drain(..).collect();
        if chars.len() == 1 {
            out.push(chars[0].to_string());
        } else {
            for w in chars.windows(2) {
                out.push(format!("{}{}", w[0], w[1]));
            }
        }
    };

    for ch in normalized.chars() {
        if is_cjk_char(ch) {
            cjk_buffer.push_back(ch);
        } else {
            if !cjk_buffer.is_empty() {
                flush_cjk(&mut cjk_buffer, &mut tokens);
            }
            // ASCII 字母数字作为单词字符累积（简化版，不严格按 TOKEN_RE）
            // 此处可改为按 TOKEN_RE 批量扫描 ASCII 段，详见实现注释
        }
    }
    if !cjk_buffer.is_empty() {
        flush_cjk(&mut cjk_buffer, &mut tokens);
    }
    tokens
}

fn is_cjk_char(ch: char) -> bool {
    matches!(ch as u32,
        0x4E00..=0x9FFF   |  // CJK 统一表意
        0x3400..=0x4DBF  |  // CJK 扩展 A
        0x20000..=0x2A6DF |  // CJK 扩展 B
        0x3040..=0x30FF   |  // 平假名/片假名
        0xAC00..=0xD7AF      // 韩文音节
    )
}
```

> 实现说明：ASCII 段（含数字/下划线/连字符）应优先复用 [rag.rs:55-57](file:///d:/game/mytemple/src-tauri/src/rag.rs#L55-L57) `TOKEN_RE` 的扫描结果，在 CJK 与 ASCII 交替处正确切换。具体实现时按「先按字符流切分 CJK 段 vs ASCII 段，ASCII 段用 TOKEN_RE 找词」的双趟扫描更稳健。

**在 `refresh_cache()` 中构建倒排索引**

[app.rs:457-510](file:///d:/game/mytemple/src-tauri/src/app.rs#L457-L510) `refresh_cache()` 当前在 L483 设置 `search_indices: Vec<usize> = (0..all_files.len()).collect();`，这是空操作。改为：

```rust
// 构建倒排索引（替代 Vec<usize> 空操作）
let mut new_index = SearchIndex::default();
new_index.total_docs = all_files.len() as u32;
new_index.doc_metas = Vec::with_capacity(all_files.len());
let mut title_len_sum: u64 = 0;
let mut body_len_sum: u64 = 0;

for (idx, file) in all_files.iter().enumerate() {
    let title_tokens = tokenize_cjk_terms(&file.title);
    let body_text = file.plain.as_ref().cloned().unwrap_or_default();
    let body_tokens = tokenize_cjk_terms(&body_text);

    title_len_sum += title_tokens.len() as u64;
    body_len_sum += body_tokens.len() as u64;
    new_index.doc_metas.push(DocMeta {
        title_len: title_tokens.len() as u32,
        body_len: body_tokens.len() as u32,
    });

    // 词频统计
    let mut tf_map: HashMap<u32, (u16, u16)> = HashMap::new();
    for t in &title_tokens {
        let id = hash_token_u32(t);
        tf_map.entry(id).or_default().0 += 1;
    }
    for t in &body_tokens {
        let id = hash_token_u32(t);
        tf_map.entry(id).or_default().1 += 1;
    }

    for (token_id, (tf_title, tf_body)) in tf_map {
        new_index.inverted.entry(token_id).or_default().push(Posting {
            doc_idx: idx as u32,
            tf_title,
            tf_body,
        });
    }
}

new_index.avg_title_len = if all_files.is_empty() { 0.0 } else { title_len_sum as f64 / all_files.len() as f64 };
new_index.avg_body_len = if all_files.is_empty() { 0.0 } else { body_len_sum as f64 / all_files.len() as f64 };
```

替换 L498-L502 中 `idx.entries = search_indices;` 为：

```rust
*idx = new_index;
```

**新增 `hash_token_u32` 工具**

用 FNV-1a 简单哈希即可，无需密码学强度：

```rust
fn hash_token_u32(s: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}
```

**重写 `search()`**

[app.rs:1421-1538](file:///d:/game/mytemple/src-tauri/src/app.rs#L1421-L1538) 完整重写：

```rust
pub async fn search(&self, query: &str) -> Vec<SearchResult> {
    fn align_boundary(s: &str, byte_pos: usize, forward: bool) -> usize {
        // 复用现有实现，不动
    }

    let query_trimmed = query.trim();
    if query_trimmed.is_empty() { return Vec::new(); }

    // 1. 解析引号精确短语（复用现有逻辑）
    let mut phrases: Vec<String> = Vec::new();
    let mut remaining = query_trimmed.to_string();
    while let Some(start) = remaining.find('"') {
        if let Some(end) = remaining[start+1..].find('"') {
            let phrase = remaining[start+1..start+1+end].to_lowercase();
            if !phrase.is_empty() { phrases.push(phrase); }
            remaining = format!("{} {}", &remaining[..start], &remaining[start+1+end+1..]);
        } else { break; }
    }

    // 2. CJK 分词（替换 split_whitespace）
    let mut tokens = tokenize_cjk_terms(&remaining);
    tokens.sort();
    tokens.dedup();
    let total_tokens = tokens.len() as u32;

    let index = self.search_index.read().await;
    let files = self.files.read().await;

    if index.total_docs == 0 { return Vec::new(); }

    // 3. OR 候选集：任一 token 命中即收集 doc_idx → 命中 token 数 + 各 token 的 Posting
    let mut candidates: HashMap<u32, Vec<(u32, Posting)>> = HashMap::new(); // doc_idx → Vec<(token_idx, posting)>
    for (token_idx, t) in tokens.iter().enumerate() {
        let tid = hash_token_u32(t);
        if let Some(postings) = index.inverted.get(&tid) {
            for p in postings {
                candidates
                    .entry(p.doc_idx)
                    .or_default()
                    .push((token_idx as u32, *p));
            }
        }
    }

    // 4. 精确短语后置过滤
    let mut scored: Vec<SearchResult> = Vec::new();
    let k1 = 1.2_f64;
    let b_body = 0.75_f64;
    let b_title = 0.5_f64;
    let w_title = 3.0_f64;
    let w_body = 1.0_f64;
    let n = index.total_docs as f64;

    for (doc_idx, hits) in candidates {
        let file = match files.get(doc_idx as usize) { Some(f) => f, None => continue };
        let title_lower = file.title.to_lowercase();
        let body_lower = file.plain.to_lowercase();

        // 精确短语必须连续命中
        if !phrases.is_empty() {
            let phrases_ok = phrases.iter().all(|p| title_lower.contains(p) || body_lower.contains(p));
            if !phrases_ok { continue; }
        }

        // BM25F
        let mut total_score: f64 = 0.0;
        let meta = &index.doc_metas[doc_idx as usize];
        let avg_t = index.avg_title_len.max(1.0);
        let avg_b = index.avg_body_len.max(1.0);
        let mut matched: Vec<String> = Vec::new();

        for (token_idx, posting) in &hits {
            let token = &tokens[*token_idx as usize];
            matched.push(token.clone());
            let df = index.inverted.get(&hash_token_u32(token))
                .map(|v| v.len() as f64).unwrap_or(1.0);
            let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();

            // title 字段
            if posting.tf_title > 0 {
                let tf = posting.tf_title as f64;
                let dl = meta.title_len as f64;
                let s = idf * (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b_title + b_title * dl / avg_t));
                total_score += w_title * s;
            }
            // body 字段
            if posting.tf_body > 0 {
                let tf = posting.tf_body as f64;
                let dl = meta.body_len as f64;
                let s = idf * (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b_body + b_body * dl / avg_b));
                total_score += w_body * s;
            }
        }
        // 精确短语加分
        for p in &phrases {
            if title_lower.contains(p) { total_score += 30.0; }
            if body_lower.contains(p) { total_score += 10.0; }
        }

        // snippet 构造（复用 align_boundary + 关键词位置）
        let matched_token_refs: Vec<&str> = matched.iter().map(|s| s.as_str()).collect();
        let snippet = build_snippet(&file.plain, &matched_token_refs, &phrases, query_trimmed.len(), align_boundary);

        scored.push(SearchResult {
            path: file.path.clone(),
            title: file.title.clone(),
            snippet,
            score: total_score,
            matched_tokens: matched,
            total_matches: hits.len() as u32,
            total_tokens,
        });
    }

    // 5. 精排：分数降序；同分按命中比例降序
    scored.sort_by(|a, b| {
        b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.total_matches.cmp(&a.total_matches))
    });
    scored
}

fn build_snippet(
    plain: &str,
    matched: &[&str],
    phrases: &[String],
    query_len: usize,
    align: fn(&str, usize, bool) -> usize,
) -> String {
    // 优先 title 命中则返回 title；否则在 plain 中定位首个匹配 token，前后 40/60 字符
    // 复用现有 align_boundary 切片逻辑
    // （实现细节按现有 L1500-L1523 改造，保持对齐与 ... 前缀处理）
    // ...
}
```

> 关键约束：`file.plain` 字段类型为 `Option<String>` 还是 `String` 需在实现时按 [app.rs:1468-1469](file:///d:/game/mytemple/src-tauri/src/app.rs#L1468-L1469) `entry.plain.to_lowercase()` 现有用法确认；若为 `Option`，需在 refresh_cache 构建倒排时用 `plain.as_deref().unwrap_or("")`。

### 文件 2：`d:\game\mytemple\src-tauri\src\ipc.rs`

[ipc.rs:170-173](file:///d:/game/mytemple/src-tauri/src/ipc.rs#L170-L173) `search()` 增加 `offset`、`limit` 参数：

```rust
pub async fn search(s: &ServerState, q: String, offset: usize, limit: usize) -> serde_json::Value {
    let mut results = s.app.search(&q).await;
    let total = results.len();
    let end = (offset + limit).min(total);
    let visible: Vec<_> = results.drain(..end.min(total)).skip(offset).collect();
    serde_json::json!({
        "results": visible,
        "total": total,
        "offset": offset,
        "limit": limit,
    })
}
```

### 文件 3：`d:\game\mytemple\src-tauri\src\handlers.rs`

[handlers.rs:541-551](file:///d:/game/mytemple/src-tauri/src/handlers.rs#L541-L551) `SearchQuery` 与 `search` 改为：

```rust
#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

async fn search(
    State(state): State<Arc<ServerState>>,
    Query(params): Query<SearchQuery>,
) -> impl IntoResponse {
    let offset = params.offset.unwrap_or(0);
    let limit = params.limit.unwrap_or(80).min(500);
    crate::ipc::ok_response(crate::ipc::search(&state, params.q, offset, limit).await)
}
```

### 文件 4：`d:\game\mytemple\public\app.js`

[app.js:8844-8893](file:///d:/game/mytemple/public/app.js#L8844-L8893) `runSearch()` 重写：

**改造点 1：分页**
- `state.searchOffset = 0`，每次 `runSearch()` 重置为 0。
- 「加载更多」按钮调用 `loadMoreSearch()`，`offset += limit`，追加结果而非替换。

**改造点 2：token 级高亮**
- 渲染前对 `item.title` / `item.snippet` 按 `item.matchedTokens` 命中位置包 `<mark class="search-hit">`：
  ```js
  function highlight(text, tokens) {
    if (!tokens || !tokens.length) return text;
    // 按 token 长度降序，避免短 token 先匹配破坏长 token
    const sorted = [...new Set(tokens)].sort((a, b) => b.length - a.length);
    const escaped = sorted.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`(${escaped.join("|")})`, "gi");
    return text.replace(re, "<mark class=\"search-hit\">$1</mark>");
  }
  ```
- 渲染改用 `innerHTML`（注意：title/snippet 来自后端可信，仍需 escape HTML 实体防 XSS——先 escape 再 highlight）。

**改造点 3：搜索历史 + 补全**
- `state.searchHistory = JSON.parse(localStorage.getItem("searchHistory") || "[]")`，最多 20 条。
- 输入框 `focus` 时下拉显示历史，回车提交后将查询 unshift 进历史并去重。
- 下拉项点击 → 填充输入框 → 触发 `runSearch()`。

**改造点 4：兼容旧响应**
- 后端响应格式变为 `{ results, total, offset, limit }`，前端解构相应调整。
- 前端默认 `limit=50`（替代硬截断 80），「加载更多」每页 50。

### 文件 5：`d:\game\mytemple\public\styles.css`（小改）

新增：
```css
.search-hit { background: rgba(250, 204, 21, 0.45); color: inherit; border-radius: 2px; padding: 0 1px; }
.search-history-dropdown { ... }   /* 下拉面板样式 */
.search-history-item { ... }
.search-load-more { ... }          /* 加载更多按钮样式 */
```

### 文件 6：`d:\game\mytemple\public\index.html`（小改）

- 在 `<input id="searchInput">` 下方追加 `<div id="searchHistoryDropdown" class="search-history-dropdown hidden"></div>`。
- 检查 app.js / styles.css 版本号是否需要 bump（按 [project_memory 工程惯例](file:///c:/Users/fshby/.trae-cn/memory/projects/-d-game-mytemple--p2-1aae5af33672aba72be4/project_memory.md) 类似 screenshot.html 的 `?v=20260920` 缓存失效惯例）。

## 不变更项

- **不修改** `d:\game\mytemple\src-tauri\src\rag.rs` 的 `tokenize()`：避免 RAG 向量索引 schema 变更导致全量重建。Phase 2 再统一。
- **不修改** `d:\game\mytemple\server\rag.js`：Node 服务层 RAG 检索维持 `Intl.Segmenter`，与 Tauri 端全局检索并行不冲突。
- **不引入** 新 Cargo 依赖：BM25、FNV-1a、CJK 双字全部纯 Rust 实现。
- **不修改** `Cargo.toml`：零新增 crate。

## 假设与风险

1. **`FileEntry.plain` 字段类型**：实现时需先 Read [app.rs](file:///d:/game/mytemple/src-tauri/src/app.rs) `FileEntry` 定义确认。若为 `Option<String>`，构建索引与 snippet 提取均需 unwrap_or_default。
2. **10k 文档性能**：倒排索引构建一次约 < 500ms（10k × 200 词纯 Rust 哈希），检索 < 5ms（HashMap 查询 + BM25 排序）。符合「不影响检索速度」。
3. **内存增量**：约 16MB（10k 文档场景），符合「控制产品性能消耗」。
4. **CJK 双字召回 vs 精度**：双字会引入一定噪声（"知识" 与 "识别" 都会含 "识"），但 BM25 IDF 会降低高频双字权重，且 OR + 比例排序保证多 token 命中者排前。Phase 2 可补 jieba（Feature Gate，非默认）。
5. **HTML XSS**：前端高亮前必须先 escape 文本实体（`<`/`>`/`&`/`"`），再插入 `<mark>`。

## 验证步骤

### 阶段 1 验证（核心后端）

1. `cargo build --release` 编译通过，无 warning。
2. 启动应用，对工作区做一次 `refresh_cache`（启动时自动触发），观察日志确认倒排索引构建耗时与条目数。
3. 搜索「知识图谱」：
   - 旧版：可能 0 结果或全库 contains 命中泛滥。
   - 新版：标题/正文含「知识」「识图」「图谱」三双字的文档应排前，且 snippet 中三词被高亮。
4. 搜索 `"知识图谱"`（带引号）：仅命中连续字符串「知识图谱」的文档。
5. 搜索「java」：不再命中「javascript」（双字分词后「java」是独立 token，倒排精确匹配）。
6. 搜索「的」：高频词 IDF 极低，得分被压低，不会占据结果前列。
7. 多 token 搜索「Rust 向量检索」：任一 token 命中即入选（OR），但三 token 全命中的文档分数最高。

### 阶段 2 验证（前端）

1. 结果列表中命中关键词有黄色高亮。
2. 超过 50 条结果显示「加载更多」按钮，点击追加而非替换。
3. 输入框聚焦时显示历史下拉，回车提交后历史更新。
4. 历史项点击能触发新搜索。
5. XSS 防护：构造标题含 `<script>` 的文档，搜索结果不应执行脚本。

### 阶段 3 验证（回归）

1. 原有英文搜索、空查询、单字符查询不报错。
2. 工作区切换后 `refresh_cache` 重建索引，新文档可被检索。
3. RAG 服务（rag.rs / server/rag.js）行为不变，AI 对话检索未受影响。
4. 安装包大小无明显增长（零新依赖）。

## 实施顺序

1. **app.rs**：新增结构体 + `tokenize_cjk_terms` + `hash_token_u32` + `refresh_cache` 倒排构建 + `search()` 重写 + `build_snippet`。→ 编译通过。
2. **ipc.rs + handlers.rs**：`offset/limit` 参数。→ `/api/search?q=xxx&offset=0&limit=50` 联调通过。
3. **app.js**：分页 + 高亮 + 历史下拉。→ 浏览器实测。
4. **styles.css + index.html**：高亮样式 + 历史下拉容器 + 版本号 bump。
5. 全量回归（阶段 1-3 验证清单）。
6. （可选）Phase 2：将 `tokenize_cjk_terms` 提到 rag.rs 与 `tokenize()` 合并，评估 RAG 索引重建成本。

## 不做的事

- 不引入 jieba / Intl.Segmenter / 嵌入式向量检索到全局搜索。
- 不修改 RAG 向量索引 schema。
- 不增加 Cargo.toml 依赖。
- 不重构 `ServerState` / `AppState` 整体结构（仅在 SearchIndex 子结构内演进）。
- 不动 `screenshot.html`、`global_capture.rs` 等已完成模块。
