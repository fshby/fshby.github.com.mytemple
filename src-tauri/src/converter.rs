// converter.rs — 文档转换桥接层
// 对应 server/converter.js 的服务端接口。
// 混合架构策略：6 个 npm 包（mammoth/turndown/xlsx/marked/pdf-parse/html-to-docx）
// 已迁移到 WebView2 V8 引擎运行，Rust 端只负责文件 I/O 桥接。
//
// 职责分工：
// - Rust 端：读取文件二进制 → 传给前端 → 接收前端转换结果 → 写入文件
// - 前端端：在 WebView2 V8 中运行 npm 包，执行实际格式转换
//
// 企业级标准：文档转换必须保证数据完整性，二进制传输使用
// ArrayBuffer 零拷贝，转换失败时保留原始文件不变。

use serde::{Deserialize, Serialize};
use std::path::Path;

/// 转换请求（前端发送到 Rust 端读取文件）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertRequest {
    pub format: String,     // docx | pdf | xlsx | html
    pub file_path: String,  // 源文件路径
    pub action: String,     // to_markdown | to_html | to_docx
}

/// 转换结果（前端处理完后返回）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertResult {
    pub success: bool,
    pub content: String,       // 转换后的 Markdown/HTML 内容
    pub file_name: String,     // 原文件名
    pub error: Option<String>,
}

/// 导出请求（前端组装内容，Rust 端写入文件）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRequest {
    pub content: String,       // Markdown/HTML 内容
    pub file_path: String,     // 目标文件路径
    pub format: String,        // docx | html | pdf
}

/// 导出结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportResult {
    pub success: bool,
    pub file_path: String,
    pub file_size: u64,
    pub error: Option<String>,
}

/// 读取文件二进制（供前端转换使用）
/// 返回 Base64 编码的文件内容
pub fn read_file_for_conversion(file_path: &str) -> Result<(String, String), String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("文件不存在: {}", file_path));
    }
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    use base64::Engine;
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok((b64, file_name))
}

/// 写入导出文件（前端生成二进制后，Rust 端写入）
pub fn write_export_file(file_path: &str, b64_content: &str) -> ExportResult {
    use base64::Engine;
    let path = Path::new(file_path);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match base64::engine::general_purpose::STANDARD.decode(b64_content) {
        Ok(bytes) => {
            let file_size = bytes.len() as u64;
            match std::fs::write(path, &bytes) {
                Ok(()) => ExportResult {
                    success: true,
                    file_path: file_path.to_string(),
                    file_size,
                    error: None,
                },
                Err(e) => ExportResult {
                    success: false,
                    file_path: file_path.to_string(),
                    file_size: 0,
                    error: Some(e.to_string()),
                },
            }
        }
        Err(e) => ExportResult {
            success: false,
            file_path: file_path.to_string(),
            file_size: 0,
            error: Some(format!("Base64 解码失败: {}", e)),
        },
    }
}

/// 检测文件类型（基于扩展名）
pub fn detect_format(file_path: &str) -> &'static str {
    let ext = Path::new(file_path)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" => "markdown",
        "docx" => "docx",
        "pdf" => "pdf",
        "xlsx" | "xls" => "xlsx",
        "html" | "htm" => "html",
        "txt" => "text",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_format() {
        assert_eq!(detect_format("doc.md"), "markdown");
        assert_eq!(detect_format("report.docx"), "docx");
        assert_eq!(detect_format("data.pdf"), "pdf");
        assert_eq!(detect_format("sheet.xlsx"), "xlsx");
        assert_eq!(detect_format("page.html"), "html");
        assert_eq!(detect_format("notes.txt"), "text");
        assert_eq!(detect_format("unknown.xyz"), "unknown");
    }
}
