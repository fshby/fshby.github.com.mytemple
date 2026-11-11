// path_guard.rs — 路径与请求来源的守卫（纯 std，无外部依赖，便于独立测试）
//
// 背景（2026-11-11 安全审计实锤）：
//   `normalize_doc_path` 此前只做分隔符归一化，没有拒绝 `..`，也没有做
//   「落点是否仍在工作区内」的包含性校验。结果一个普通的只读请求
//   `GET /api/doc?path=../../../../Windows/win.ini` 就能读到系统文件；
//   同一套归一化也用于保存，写入同理。服务只监听 127.0.0.1，但服务端
//   不校验 Host 头，恶意网页可用 DNS rebinding 把自己变成「同源」再读本机文件。
//
// 这里把两件事拆成可单测的纯函数：
//   1. sanitize_relative — 相对路径净化（拒绝 `..`、盘符、UNC、结尾点/空格等
//      Windows 别名形态），返回安全的纯相对路径或 None；
//   2. path_within — 大小写不敏感、按路径分隔边界判断的包含性比较；
//   3. is_allowed_host — Host 头白名单（只认回环名，防 DNS rebinding）。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// 把用户/前端传来的相对路径净化为安全的纯相对路径。
///
/// 拒绝（返回 None）：
///   - 任何 `..` 段（穿越意图本身就不合法）；
///   - 含 `:` 的段（Windows 盘符 `C:`、NTFS 备用数据流 `file.txt:stream`）；
///   - 以 `.` 或空格结尾的段（Windows 会静默去掉，`foo.` 与 `foo` 同一文件，
///     会造成「校验的路径」与「实际打开的路径」不一致）；
///   - 空路径。
///
/// 允许并归一化：空段与 `.` 段直接丢弃（`a//b`、`./a` → `a`），反斜杠按分隔符处理
/// （调用方可能来自 Windows 前端）。
pub fn sanitize_relative(input: &str) -> Option<String> {
    let unified = input.replace('\\', "/");
    let mut segs: Vec<&str> = Vec::new();
    for seg in unified.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return None;
        }
        // Windows 保留/别名形态：盘符（C:）、ADS（a:b）、结尾的点或空格
        if seg.contains(':') {
            return None;
        }
        if seg.ends_with('.') || seg.ends_with(' ') {
            return None;
        }
        // 控制字符（含 \0）在所有平台都非法
        if seg.chars().any(|c| c.is_control()) {
            return None;
        }
        segs.push(seg);
    }
    if segs.is_empty() {
        return None;
    }
    Some(segs.join("/"))
}

/// `child` 是否落在 `parent` 之内（按路径分隔边界比较，Windows 大小写不敏感）。
///
/// 注意不能用裸 `starts_with` 字符串比较：`C:\data2` 会误判为在 `C:\data` 之内。
pub fn path_within(child: &str, parent: &str) -> bool {
    fn norm(p: &str) -> String {
        let s = p.replace('\\', "/").to_lowercase();
        // 去掉结尾多余的 `/`（但保留根 `/`）
        let trimmed = s.trim_end_matches('/');
        if trimmed.is_empty() {
            "/".to_string()
        } else {
            trimmed.to_string()
        }
    }
    let c = norm(child);
    let p = norm(parent);
    if c == p {
        return true;
    }
    let prefix = if p.ends_with('/') { p.clone() } else { format!("{}/", p) };
    c.starts_with(&prefix)
}

/// 计算「最深的已存在祖先」并 canonicalize，再把剩余段拼回去。
///
/// 用于保存新文件时也做包含性校验：新文件本身不存在，无法 canonicalize，
/// 但它的父目录存在。任何一环出错都返回 None（宁拒绝不放过）。
pub fn resolve_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut probe: PathBuf = path.to_path_buf();
    let mut rest: Vec<OsString> = Vec::new();
    loop {
        if probe.exists() {
            let mut canon = std::fs::canonicalize(&probe).ok()?;
            for seg in rest.iter().rev() {
                canon.push(seg);
            }
            return Some(canon);
        }
        let name = probe.file_name()?.to_os_string();
        rest.push(name);
        if !probe.pop() {
            return None;
        }
        // 防御：路径段过多（畸形输入）直接放弃
        if rest.len() > 512 {
            return None;
        }
    }
}

/// 绝对路径是否安全落在 root 之内。
///
/// 同时解析符号链接（对已存在的祖先 canonicalize），因此「工作区内指向工作区外的
/// 软链接」也会被拒。
pub fn is_within_root(absolute: &Path, root: &Path) -> bool {
    let root_canon = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let Some(resolved) = resolve_existing_ancestor(absolute) else {
        return false;
    };
    path_within(
        &resolved.to_string_lossy(),
        &root_canon.to_string_lossy(),
    )
}

/// Host 头是否属于回环（服务只绑定 127.0.0.1，非回环 Host 一律视为 DNS rebinding）。
pub fn is_allowed_host(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    if h.is_empty() {
        return false;
    }
    // IPv6 带方括号：`[::1]:7321`
    if let Some(end) = h.find(']') {
        let bare = &h[..=end];
        return bare == "[::1]";
    }
    // 裸 IPv6（无方括号、无端口）：`::1`
    if h == "::1" {
        return true;
    }
    // host:port → 取 host 部分
    let name = match h.rsplit_once(':') {
        Some((name, port)) if !name.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => name,
        Some(_) => return false,
        None => h.as_str(),
    };
    matches!(name, "127.0.0.1" | "localhost")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal() {
        assert_eq!(sanitize_relative("../../../../Windows/win.ini"), None);
        assert_eq!(sanitize_relative("a/../../b"), None);
        assert_eq!(sanitize_relative("..\\..\\x"), None);
    }

    #[test]
    fn rejects_windows_aliases() {
        assert_eq!(sanitize_relative("C:/Windows/win.ini"), None);
        assert_eq!(sanitize_relative("C:\\Windows\\win.ini"), None);
        assert_eq!(sanitize_relative("//server/share/x"), Some("server/share/x".into()));
        assert_eq!(sanitize_relative("note.txt:stream"), None);
        assert_eq!(sanitize_relative("note."), None);
        assert_eq!(sanitize_relative("note "), None);
        assert_eq!(sanitize_relative("a\u{0}b"), None);
    }

    #[test]
    fn keeps_normal_paths() {
        assert_eq!(sanitize_relative("docs/note.md"), Some("docs/note.md".into()));
        assert_eq!(sanitize_relative("./docs//note.md"), Some("docs/note.md".into()));
        assert_eq!(sanitize_relative("docs\\note.md"), Some("docs/note.md".into()));
        assert_eq!(sanitize_relative("  "), None);
        assert_eq!(sanitize_relative(""), None);
    }

    #[test]
    fn containment_uses_segment_boundary() {
        assert!(path_within("D:/data/a.md", "D:/data"));
        assert!(path_within("d:\\DATA\\a.md", "D:/data"));
        assert!(path_within("D:/data", "D:/data"));
        assert!(!path_within("D:/data2/a.md", "D:/data"));
        assert!(!path_within("D:/other/a.md", "D:/data"));
    }

    #[test]
    fn host_allowlist() {
        assert!(is_allowed_host("127.0.0.1:7321"));
        assert!(is_allowed_host("127.0.0.1"));
        assert!(is_allowed_host("localhost:7321"));
        assert!(is_allowed_host("LOCALHOST"));
        assert!(is_allowed_host("[::1]:7321"));
        assert!(is_allowed_host("::1"));
        assert!(!is_allowed_host("evil.example.com"));
        assert!(!is_allowed_host("evil.example.com:7321"));
        assert!(!is_allowed_host("127.0.0.1.evil.com"));
        assert!(!is_allowed_host(""));
        assert!(!is_allowed_host("[::2]:7321"));
        assert!(!is_allowed_host("tauri.localhost"));
    }
}
