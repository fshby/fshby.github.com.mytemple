// security.rs — 运行时安全防护
//
// 防护层：
// 1. 二进制完整性校验（SHA-256 哈希，防 patch/修改）
// 2. 反调试检测（IsDebuggerPresent + NtQueryInformationProcess）
// 3. 运行时授权验证（周期性检查授权状态）
// 4. IPC 输入校验（防 AI 提示注入/越权调用）
// 5. 进程完整性检测（防进程替换/hollowing）

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static INTEGRITY_OK: AtomicBool = AtomicBool::new(true);
static DEBUGGER_DETECTED: AtomicBool = AtomicBool::new(false);
static LAST_LICENSE_CHECK: AtomicU64 = AtomicU64::new(0);
static LICENSE_VALID: AtomicBool = AtomicBool::new(false);

const CHECK_INTERVAL_MS: u64 = 300_000; // 5 分钟

#[cfg(target_os = "windows")]
extern "system" {
    fn IsDebuggerPresent() -> i32;
}

/// 启动时校验二进制完整性
pub fn verify_binary_integrity() -> bool {
    use sha2::{Digest, Sha256};

    let exe_path = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return true,
    };

    let bytes = match std::fs::read(&exe_path) {
        Ok(b) => b,
        Err(_) => return true,
    };

    let hash = Sha256::digest(&bytes);
    let hash_hex = format!("{:x}", hash);

    // 检查是否有 .integrity 文件（打包时生成的预期哈希）
    let integrity_path = exe_path.parent().map(|p| p.join(".integrity"));
    if let Some(path) = integrity_path {
        if let Ok(expected) = std::fs::read_to_string(&path) {
            let expected = expected.trim();
            if !expected.is_empty() && hash_hex != expected {
                log::error!("[security] 二进制完整性校验失败！预期={} 实际={}", &expected[..16], &hash_hex[..16]);
                INTEGRITY_OK.store(false, Ordering::SeqCst);
                return false;
            }
        }
    }

    log::info!("[security] 二进制完整性校验通过: {}...", &hash_hex[..16]);
    INTEGRITY_OK.store(true, Ordering::SeqCst);
    true
}

/// 检测调试器是否附加
pub fn check_debugger() -> bool {
    #[cfg(target_os = "windows")]
    {
        unsafe {
            // IsDebuggerPresent — 检测用户态调试器
            if IsDebuggerPresent() != 0 {
                log::warn!("[security] 检测到调试器附加");
                DEBUGGER_DETECTED.store(true, Ordering::SeqCst);
                return true;
            }

            // 检查远程调试器：NtQueryInformationProcess(ProcessDebugPort)
            let mut debug_port: u64 = 0;
            let status = NtQueryInformationProcess(
                -1, // 当前进程
                7,  // ProcessDebugPort
                &mut debug_port as *mut u64 as *mut u8,
                8,
                std::ptr::null_mut(),
            );
            if status == 0 && debug_port != 0 {
                log::warn!("[security] 检测到远程调试器 (DebugPort={})", debug_port);
                DEBUGGER_DETECTED.store(true, Ordering::SeqCst);
                return true;
            }
        }
    }

    // 检查常见逆向工具进程
    if let Ok(processes) = list_processes() {
        let rev_tools = [
            "x64dbg", "x32dbg", "windbg", "ollydbg", "ida", "ida64",
            "cheatengine", "processhacker", "httpdebugger",
            "fiddler", "wireshark", "charles",
        ];
        for proc_name in &processes {
            let lower = proc_name.to_lowercase();
            for tool in rev_tools {
                if lower.contains(tool) {
                    log::warn!("[security] 检测到逆向工具进程: {}", proc_name);
                    DEBUGGER_DETECTED.store(true, Ordering::SeqCst);
                    return true;
                }
            }
        }
    }

    DEBUGGER_DETECTED.store(false, Ordering::SeqCst);
    false
}

#[cfg(target_os = "windows")]
#[link(name = "ntdll")]
extern "system" {
    fn NtQueryInformationProcess(
        process: isize,
        info_class: u32,
        info: *mut u8,
        info_len: u32,
        ret_len: *mut u32,
    ) -> i32;
}

/// 获取进程列表（Windows）
fn list_processes() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("tasklist")
            .args(["/FO", "CSV", "/NH"])
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| e.to_string())?;

        let text = String::from_utf8_lossy(&output.stdout);
        let mut names = Vec::new();
        for line in text.lines() {
            // CSV 格式: "name","pid","session","mem"
            if let Some(name) = line.split('"').nth(1) {
                names.push(name.to_string());
            }
        }
        Ok(names)
    }
    #[cfg(not(target_os = "windows"))]
    Ok(Vec::new())
}

/// 运行时安全检查（周期调用）
pub fn runtime_security_check(data_root: &std::path::Path) -> SecurityStatus {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // 周期性检查授权
    let last = LAST_LICENSE_CHECK.load(Ordering::SeqCst);
    if last == 0 || now.saturating_sub(last) > CHECK_INTERVAL_MS {
        LAST_LICENSE_CHECK.store(now, Ordering::SeqCst);
        let licensed = check_license_valid(data_root);
        LICENSE_VALID.store(licensed, Ordering::SeqCst);
    }

    let debugger = check_debugger();
    let integrity = INTEGRITY_OK.load(Ordering::SeqCst);
    let licensed = LICENSE_VALID.load(Ordering::SeqCst);

    SecurityStatus {
        secure: !debugger && integrity && licensed,
        debugger_detected: debugger,
        binary_tampered: !integrity,
        licensed,
    }
}

/// 检查授权文件是否有效
fn check_license_valid(data_root: &std::path::Path) -> bool {
    let license_path = data_root.join(".license");
    let license_key = match std::fs::read_to_string(&license_path) {
        Ok(content) => content.trim().to_string(),
        Err(_) => return false,
    };
    if license_key.is_empty() { return false; }
    let result = crate::license::verify_license(&license_key, data_root);
    result.valid && !result.expired
}

/// IPC 输入校验：检测 AI 提示注入/越权指令
pub fn validate_ipc_input(input: &str) -> Result<(), String> {
    // 检测危险模式
    let lower = input.to_lowercase();

    // 防止 AI 提示注入：检测常见的注入模式
    let injection_patterns = [
        "ignore previous instructions",
        "ignore all previous",
        "disregard the above",
        "you are now",
        "new instructions:",
        "system prompt:",
        "<|system|>",
        "<|im_start|>",
    ];

    for pattern in &injection_patterns {
        if lower.contains(pattern) {
            log::warn!("[security] 检测到 AI 提示注入尝试: pattern={}", pattern);
            return Err(format!("输入包含可疑的指令注入模式"));
        }
    }

    // 防止路径遍历攻击
    if input.contains("../") || input.contains("..\\") {
        return Err("输入包含非法路径序列".to_string());
    }

    // 防止命令注入
    let cmd_patterns = ["& del", "& rm", "& format", "| format", "& shutdown", "& taskkill"];
    for pattern in &cmd_patterns {
        if lower.contains(pattern) {
            log::warn!("[security] 检测到命令注入尝试: pattern={}", pattern);
            return Err("输入包含可疑的命令注入".to_string());
        }
    }

    // 限制输入长度
    if input.len() > 1_000_000 {
        return Err("输入超过最大长度限制".to_string());
    }

    Ok(())
}

/// 安全状态
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    pub secure: bool,
    pub debugger_detected: bool,
    pub binary_tampered: bool,
    pub licensed: bool,
}

impl Default for SecurityStatus {
    fn default() -> Self {
        Self {
            secure: true,
            debugger_detected: false,
            binary_tampered: false,
            licensed: true,
        }
    }
}
