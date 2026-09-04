// license.rs — RSA-SHA256 授权验证
// 对应 server/license.js，使用内嵌公钥验证授权码签名。
// 企业级标准：授权验证必须包含机器码绑定、时间回拨防护、
// 高水位线机制三重安全层，任何一层失败都不应锁定已授权用户。
//
// 安全层：
// 1. RSA-2048 签名验证（公钥内嵌，私钥不随软件分发）
// 2. 机器码绑定（SHA-256 指纹前 32 字符）
// 3. 高水位线防时间作弊（记录曾见过的最大时间戳）

use base64::Engine;
use rsa::pkcs8::DecodePublicKey;
use rsa::{Pkcs1v15Sign, RsaPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// 内嵌公钥（签发端私钥不随软件分发）
const PUBLIC_KEY_PEM: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAriiZIkQGptUmfoKhMsrc
1Ph9byA0otI/QCZzWe/hAGXY1m8o7pr/PemHQaBKXRchz2eutbQJewEKNcuiyUBd
Ln7KmQiOnVaVTogkrtcZXHuWMOguEXJ8KptY1cyOpY2QpnM0tkw+AA9BB/p80g0O
u74wALQnIgppRN3oTdg+IMWOrpGWDCAYd1Hi5ETg1EEw1pshsb1EXLz3bcc7aLFH
06gdKWvrFSuzH00aO/YLstv3Y4GdBb8CtB2B/iFZpjpMlWa2yL5pn7X8ulTmqU2h
/Mv6ulZMRlM1M/clOAgE2LkIazVJfrbjRQQRUyPUvl+WWXs3VatuHjXmq4bMO8wD
/wIDAQAB
-----END PUBLIC KEY-----"#;

/// 缓存
static HARDWARE_CACHE: Mutex<Option<String>> = Mutex::new(None);
static MACHINE_CODE_CACHE: Mutex<Option<String>> = Mutex::new(None);
static MACHINE_FINGERPRINT_CACHE: Mutex<Option<String>> = Mutex::new(None);
static SYSTEM_REF_TIME_CACHE: Mutex<Option<u64>> = Mutex::new(None);

/// 授权验证结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseResult {
    pub valid: bool,
    pub expired: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiry: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub machine_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issued_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_rolled_back: Option<bool>,
}

/// 授权状态概要
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub machine_code: String,
    pub current_time: u64,
    pub high_water_mark: u64,
    pub system_ref_time: u64,
    pub clock_tampered: bool,
}

/// 获取当前 Unix 毫秒时间戳
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 获取 Windows 平台硬件标识
fn get_hardware_identifiers() -> String {
    // 检查缓存
    if let Some(cached) = HARDWARE_CACHE.lock().unwrap().clone() {
        return cached;
    }

    let mut parts: Vec<String> = Vec::new();

    // MAC 地址（通过 ipconfig 获取第一个非虚拟网卡）
    if let Some(mac) = get_mac_address() {
        parts.push(format!("mac:{}", mac));
    }

    // Windows 硬件信息（单次 PowerShell 调用）
    if cfg!(target_os = "windows") {
        let script = "$cpu=(Get-CimInstance Win32_Processor).ProcessorId; $disk=(Get-CimInstance Win32_DiskDrive | Select-Object -First 1).SerialNumber; $board=(Get-CimInstance Win32_BaseBoard).SerialNumber; $uuid=(Get-CimInstance Win32_ComputerSystemProduct).UUID; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output \"$cpu|$disk|$board|$uuid\"";
        for _attempt in 0..3 {
            if let Ok(output) = run_powershell(script, 15) {
                let fields: Vec<&str> = output.trim().split('|').collect();
                if fields.len() == 4
                    && fields.iter().all(|f| !f.trim().is_empty())
                {
                    parts.push(format!("cpu:{}", fields[0].trim()));
                    parts.push(format!("disk:{}", fields[1].trim()));
                    parts.push(format!("board:{}", fields[2].trim()));
                    parts.push(format!("uuid:{}", fields[3].trim()));
                    break;
                }
            }
        }
    }

    // 退路：hostname + CPU 型号
    if parts.len() < 2 {
        parts.push(format!("host:{}", get_hostname()));
        parts.push(format!("cpumodel:{}", get_cpu_model()));
    }

    let result = parts.join("|");
    *HARDWARE_CACHE.lock().unwrap() = Some(result.clone());
    result
}

/// 生成机器码（用户可见的短码）
/// 取硬件指纹的 SHA-256 前 16 字节，Base36 编码，分 4 组展示
pub fn get_machine_code() -> String {
    if let Some(cached) = MACHINE_CODE_CACHE.lock().unwrap().clone() {
        return cached;
    }
    let raw = get_hardware_identifiers();
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    let hash = hasher.finalize();
    // 取前 16 字节 → 32 hex 字符
    let hex: String = hash.iter().take(16).map(|b| format!("{:02x}", b)).collect();

    // 转 Base36
    let code = hex_to_base36(&hex);
    let padded = format!("{:0>25}", code);
    // 分 5 组，每组 5 字符
    let grouped = padded
        .as_bytes()
        .chunks(5)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-");

    *MACHINE_CODE_CACHE.lock().unwrap() = Some(grouped.clone());
    grouped
}

/// 获取机器指纹完整哈希（内部使用）
pub fn get_machine_fingerprint() -> String {
    if let Some(cached) = MACHINE_FINGERPRINT_CACHE.lock().unwrap().clone() {
        return cached;
    }
    let raw = get_hardware_identifiers();
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    let hash = hasher.finalize();
    let hex: String = hash.iter().map(|b| format!("{:02x}", b)).collect();
    *MACHINE_FINGERPRINT_CACHE.lock().unwrap() = Some(hex.clone());
    hex
}

/// 计算回退指纹（仅 MAC + 主机名 + CPU 型号）
fn get_fallback_fingerprint() -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(mac) = get_mac_address() {
        parts.push(format!("mac:{}", mac));
    }
    parts.push(format!("host:{}", get_hostname()));
    parts.push(format!("cpumodel:{}", get_cpu_model()));
    let raw = parts.join("|");
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    let hash = hasher.finalize();
    hash.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 高水位线文件路径
fn high_water_file_path(data_root: &Path) -> PathBuf {
    data_root.join(".hwmark")
}

/// 读取高水位线
fn get_high_water_mark(data_root: &Path) -> (u64, u64, u64) {
    // ref_time, file_time, file_mtime
    let ref_time = get_system_reference_time();
    let hw_path = high_water_file_path(data_root);
    let (mut file_time, mut file_mtime) = (0u64, 0u64);
    if let Ok(content) = std::fs::read_to_string(&hw_path) {
        if let Ok(data) = serde_json::from_str::<serde_json::Value>(&content) {
            file_time = data["t"].as_u64().unwrap_or(0);
            file_mtime = data["m"].as_u64().unwrap_or(0);
        }
    }
    (ref_time, file_time, file_mtime)
}

/// 更新高水位线
fn update_high_water_mark(data_root: &Path, current_time: u64) -> u64 {
    let hw_path = high_water_file_path(data_root);
    let prev = std::fs::read_to_string(&hw_path)
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .unwrap_or(serde_json::json!({}));
    let prev_time = prev["t"].as_u64().unwrap_or(0);
    let max_time = current_time.max(prev_time);
    let now = now_ms();
    let data = serde_json::json!({ "t": max_time, "m": now, "v": 1 });
    if let Some(dir) = hw_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&hw_path, data.to_string());
    max_time
}

/// 系统安装时间（Windows 注册表交叉校验）
/// 缓存：系统安装时间不变，PowerShell/WMI 查询较慢，首次结果缓存
fn get_system_reference_time() -> u64 {
    if let Some(cached) = SYSTEM_REF_TIME_CACHE.lock().unwrap().clone() {
        return cached;
    }
    let result = compute_system_reference_time();
    *SYSTEM_REF_TIME_CACHE.lock().unwrap() = Some(result);
    result
}

fn compute_system_reference_time() -> u64 {
    if cfg!(target_os = "windows") {
        if let Ok(output) = run_powershell(
            "(Get-CimInstance Win32_OperatingSystem).InstallDate",
            5,
        ) {
            let trimmed = output.trim();
            // 尝试解析 WMI 日期格式
            if let Some(ts) = parse_wmi_date(trimmed) {
                return ts;
            }
            // 尝试标准日期解析
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(trimmed) {
                return dt.timestamp_millis() as u64;
            }
        }
    }
    now_ms()
}

/// 验证授权码
pub fn verify_license(license_key: &str, data_root: &Path) -> LicenseResult {
    let machine_code = get_machine_code();

    // 清理 Base64
    let cleaned = license_key.replace(|c: char| c.is_whitespace(), "");
    let raw = match base64::engine::general_purpose::STANDARD.decode(&cleaned) {
        Ok(d) => d,
        Err(e) => {
            return LicenseResult {
                valid: false,
                expired: false,
                error: Some(format!("授权码格式错误: {}", e)),
                machine_code,
                expiry: None,
                issued_at: None,
                time_rolled_back: None,
            };
        }
    };

    if raw.len() < 5 {
        return LicenseResult {
            valid: false,
            expired: false,
            error: Some("授权码格式错误: 数据过短".to_string()),
            machine_code,
            expiry: None,
            issued_at: None,
            time_rolled_back: None,
        };
    }

    // 解析格式：[4字节长度][签名][JSON载荷]
    let sig_len = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
    if raw.len() < 4 + sig_len {
        return LicenseResult {
            valid: false,
            expired: false,
            error: Some("授权码格式错误: 签名长度不匹配".to_string()),
            machine_code,
            expiry: None,
            issued_at: None,
            time_rolled_back: None,
        };
    }
    let signature = &raw[4..4 + sig_len];
    let payload_json = std::str::from_utf8(&raw[4 + sig_len..]).unwrap_or("");
    let payload: serde_json::Value = match serde_json::from_str(payload_json) {
        Ok(v) => v,
        Err(e) => {
            return LicenseResult {
                valid: false,
                expired: false,
                error: Some(format!("授权码格式错误: {}", e)),
                machine_code,
                expiry: None,
                issued_at: None,
                time_rolled_back: None,
            };
        }
    };

    // 1. 验证 RSA-SHA256 签名
    let sig_valid = verify_rsa_signature(payload_json.as_bytes(), signature);
    if !sig_valid {
        return LicenseResult {
            valid: false,
            expired: false,
            error: Some("授权码签名无效".to_string()),
            machine_code,
            expiry: None,
            issued_at: None,
            time_rolled_back: None,
        };
    }

    // 2. 验证机器码绑定（前 32 hex 字符）
    let expected_fp = &get_machine_fingerprint()[..32];
    let payload_fp = payload["fp"].as_str().unwrap_or("");
    if payload_fp != expected_fp {
        // 兼容旧授权：检查回退指纹
        let fallback_fp = &get_fallback_fingerprint()[..32];
        if payload_fp != fallback_fp {
            return LicenseResult {
                valid: false,
                expired: false,
                error: Some("授权码与当前设备不匹配".to_string()),
                machine_code,
                expiry: None,
                issued_at: None,
                time_rolled_back: None,
            };
        }
    }

    // 3. 防时间作弊检查
    let now = now_ms();
    let (ref_time, file_time, _file_mtime) = get_high_water_mark(data_root);

    // 系统安装时间不能晚于当前时间
    if ref_time > now + 60000 {
        return LicenseResult {
            valid: false,
            expired: false,
            error: Some("检测到系统时间异常，请校正后重试".to_string()),
            machine_code,
            expiry: None,
            issued_at: None,
            time_rolled_back: None,
        };
    }

    // 检测时间回拨
    let time_rolled_back = file_time > 0 && now < file_time - 5 * 60 * 1000;
    let effective_now = if time_rolled_back { file_time } else { now };

    // 4. 检查有效期
    let expiry = payload["exp"].as_u64().unwrap_or(0);
    if expiry > 0 && effective_now > expiry {
        if time_rolled_back {
            if now > expiry {
                // 真实当前时间也超过有效期
                return LicenseResult {
                    valid: false,
                    expired: true,
                    expiry: Some(expiry),
                    error: Some("授权已过期".to_string()),
                    machine_code,
                    issued_at: None,
                    time_rolled_back: Some(true),
                };
            }
            // 高水位线时已过期，但真实时间未过期 → 锁定
            return LicenseResult {
                valid: false,
                expired: true,
                expiry: Some(expiry),
                error: Some(
                    "检测到系统时间回拨，授权已过期。请联系管理员重新激活。".to_string(),
                ),
                machine_code,
                issued_at: None,
                time_rolled_back: Some(true),
            };
        }
        // 正常过期
        update_high_water_mark(data_root, now);
        return LicenseResult {
            valid: false,
            expired: true,
            expiry: Some(expiry),
            error: Some("授权已过期".to_string()),
            machine_code,
            issued_at: None,
            time_rolled_back: None,
        };
    }

    // 5. 检查签发时间
    let issued_at = payload["iat"].as_u64().unwrap_or(0);
    if issued_at > effective_now + 60000 {
        return LicenseResult {
            valid: false,
            expired: false,
            error: Some("授权码签发时间异常".to_string()),
            machine_code,
            expiry: None,
            issued_at: Some(issued_at),
            time_rolled_back: None,
        };
    }

    // 验证通过，更新高水位线
    let update_time = if time_rolled_back {
        now.max(file_time)
    } else {
        now
    };
    update_high_water_mark(data_root, update_time);

    LicenseResult {
        valid: true,
        expired: false,
        expiry: if expiry > 0 { Some(expiry) } else { None },
        issued_at: if issued_at > 0 { Some(issued_at) } else { None },
        machine_code,
        time_rolled_back: if time_rolled_back { Some(true) } else { None },
        error: None,
    }
}

/// 获取授权状态概要
pub fn get_license_status(data_root: &Path) -> LicenseStatus {
    let machine_code = get_machine_code();
    let (ref_time, file_time, _) = get_high_water_mark(data_root);
    let now = now_ms();
    LicenseStatus {
        machine_code,
        current_time: now,
        high_water_mark: file_time,
        system_ref_time: ref_time,
        clock_tampered: file_time > 0 && now < file_time - 5 * 60 * 1000,
    }
}

// ── RSA 签名验证 ──────────────────────────────────────────

fn verify_rsa_signature(data: &[u8], signature: &[u8]) -> bool {
    // 解析公钥
    let public_key = match RsaPublicKey::from_public_key_pem(PUBLIC_KEY_PEM) {
        Ok(pk) => pk,
        Err(_) => return false,
    };

    // 计算 SHA-256 哈希
    let hash = Sha256::digest(data);

    // PKCS#1 v1.5 签名验证
    public_key
        .verify(Pkcs1v15Sign::new::<Sha256>(), &hash, signature)
        .is_ok()
}

// ── 系统信息获取 ──────────────────────────────────────────

fn run_powershell(script: &str, timeout_secs: u64) -> Result<String, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x08000000)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut stdout);
                }
                if status.success() {
                    return Ok(stdout);
                } else {
                    let mut stderr = String::new();
                    if let Some(mut err) = child.stderr.take() {
                        let _ = err.read_to_string(&mut stderr);
                    }
                    return Err(stderr);
                }
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("PowerShell timed out after {}s", timeout_secs));
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn get_mac_address() -> Option<String> {
    use std::process::Command;
    let output = Command::new("ipconfig")
        .arg("/all")
        .creation_flags(0x08000000)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    // 查找物理地址
    for line in text.lines() {
        let trimmed = line.trim();
        // 匹配 "XX-XX-XX-XX-XX-XX" 格式的 MAC 地址
        let mac = trimmed
            .split_whitespace()
            .find(|word| {
                word.len() == 17
                    && word.matches('-').count() == 5
                    && word.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
            })
            .map(|s| s.replace('-', ":"));
        if let Some(mac) = mac {
            if mac != "00:00:00:00:00:00" {
                return Some(mac);
            }
        }
    }
    None
}

fn get_hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn get_cpu_model() -> String {
    use std::process::Command;
    Command::new("wmic")
        .args(["cpu", "get", "name"])
        .creation_flags(0x08000000)
        .output()
        .ok()
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            text.lines()
                .nth(1)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "unknown".to_string())
}

/// 将 hex 字符串转为 Base36
fn hex_to_base36(hex: &str) -> String {
    // 将 hex 字符串解析为大整数（手动实现，不依赖 num-bigint）
    let mut value: Vec<u8> = vec![0]; // 大端字节
    for hex_byte in hex.as_bytes().chunks(2) {
        let hex_pair = std::str::from_utf8(hex_byte).unwrap_or("00");
        let byte = u8::from_str_radix(hex_pair, 16).unwrap_or(0);
        // value = value * 256 + byte
        let mut carry = byte;
        for digit in value.iter_mut().rev() {
            let product = (*digit as u16) * 256 + carry as u16;
            *digit = (product & 0xFF) as u8;
            carry = (product >> 8) as u8;
        }
        if carry > 0 {
            value.insert(0, carry);
        }
    }
    // 大整数转 Base36
    let mut result = String::new();
    while !value.iter().all(|&d| d == 0) {
        let mut remainder: u16 = 0;
        for digit in value.iter_mut() {
            let num = (remainder << 8) | *digit as u16;
            *digit = (num / 36) as u8;
            remainder = num % 36;
        }
        // 去除前导零
        while value.len() > 1 && value[0] == 0 {
            value.remove(0);
        }
        let c = if remainder < 10 {
            (b'0' + remainder as u8) as char
        } else {
            (b'a' + (remainder - 10) as u8) as char
        };
        result.insert(0, c);
    }
    if result.is_empty() {
        result.push('0');
    }
    result
}

/// 解析 WMI/CIM 日期格式（如 20250101120000.000000+480）
fn parse_wmi_date(s: &str) -> Option<u64> {
    // 格式：YYYYMMDDHHMMSS.mmmmmm+UTC
    if s.len() < 14 {
        return None;
    }
    let year: u32 = s[0..4].parse().ok()?;
    let month: u32 = s[4..6].parse().ok()?;
    let day: u32 = s[6..8].parse().ok()?;
    let hour: u32 = s[8..10].parse().ok()?;
    let min: u32 = s[10..12].parse().ok()?;
    let sec: u32 = s[12..14].parse().ok()?;
    let dt = chrono::NaiveDateTime::new(
        chrono::NaiveDate::from_ymd_opt(year as i32, month, day)?,
        chrono::NaiveTime::from_hms_opt(hour, min, sec)?,
    );
    dt.and_local_timezone(chrono::Utc)
        .single()
        .map(|dt| dt.timestamp_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_machine_code_format() {
        let code = get_machine_code();
        // 应为 XXXXX-XXXXX-XXXXX-XXXXX-XXXXX 格式
        assert!(code.len() >= 25);
        assert_eq!(code.matches('-').count(), 4);
    }

    #[test]
    fn test_hex_to_base36() {
        let result = hex_to_base36("ff");
        assert_eq!(result, "57");
    }

    #[test]
    fn test_license_status() {
        // 需要一个临时目录
        let tmp = std::env::temp_dir().join("mytemple_test_license");
        let status = get_license_status(&tmp);
        assert!(!status.machine_code.is_empty());
        assert!(status.current_time > 0);
    }
}
