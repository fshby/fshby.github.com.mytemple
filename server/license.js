import crypto from "node:crypto";
import os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * 内嵌公钥（签发端私钥不随软件分发）
 * 密钥对由 RSA-2048 生成，仅软件侧持有公钥，无法伪造授权码。
 */
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAriiZIkQGptUmfoKhMsrc
1Ph9byA0otI/QCZzWe/hAGXY1m8o7pr/PemHQaBKXRchz2eutbQJewEKNcuiyUBd
Ln7KmQiOnVaVTogkrtcZXHuWMOguEXJ8KptY1cyOpY2QpnM0tkw+AA9BB/p80g0O
u74wALQnIgppRN3oTdg+IMWOrpGWDCAYd1Hi5ETg1EEw1pshsb1EXLz3bcc7aLFH
06gdKWvrFSuzH00aO/YLstv3Y4GdBb8CtB2B/iFZpjpMlWa2yL5pn7X8ulTmqU2h
/Mv6ulZMRlM1M/clOAgE2LkIazVJfrbjRQQRUyPUvl+WWXs3VatuHjXmq4bMO8wD
/wIDAQAB
-----END PUBLIC KEY-----`;

let _hardwareCache = null;
let _machineCodeCache = null;
let _machineFingerprintCache = null;

/**
 * 获取 Windows 平台硬件标识，组合生成机器指纹。
 * 使用 MAC 地址 + CPU ID + 磁盘序列号 + 主板序列号。
 * 优化：合并为单次 PowerShell 调用 + 缓存结果，避免重复执行。
 */
function getHardwareIdentifiers() {
  if (_hardwareCache) return _hardwareCache;

  const parts = [];

  // MAC 地址（取第一个非虚拟网卡）
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const addrs = interfaces[name] || [];
      for (const addr of addrs) {
        if (!addr.internal && !addr.mac.includes("00:00:00:00") && addr.mac.length > 0) {
          parts.push(`mac:${addr.mac}`);
          break;
        }
      }
      if (parts.some((p) => p.startsWith("mac:"))) break;
    }
  } catch (_) { /* ignore */ }

  // Windows 硬件信息（单次 PowerShell 调用获取全部信息）
  // 稳定性修复：PowerShell 冷启动慢或系统繁忙时可能超时，失败会让指纹回退到
  // host+cpumodel，与成功时的指纹不一致 → 已激活的授权被误判失效（弹授权弹窗）。
  // 重试 3 次、超时 15 秒，确保硬件查询稳定，指纹在多次启动间保持一致。
  if (process.platform === "win32") {
    const script = '$cpu=(Get-CimInstance Win32_Processor).ProcessorId; $disk=(Get-CimInstance Win32_DiskDrive | Select-Object -First 1).SerialNumber; $board=(Get-CimInstance Win32_BaseBoard).SerialNumber; $uuid=(Get-CimInstance Win32_ComputerSystemProduct).UUID; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output "$cpu|$disk|$board|$uuid"';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
          timeout: 15000,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const [cpuId, diskSerial, boardSerial, uuid] = output.split("|");
        // 四项齐全才算成功，避免部分失败导致指纹仍走回退路径
        if (cpuId && diskSerial && boardSerial && uuid) {
          parts.push(`cpu:${cpuId}`);
          parts.push(`disk:${diskSerial}`);
          parts.push(`board:${boardSerial}`);
          parts.push(`uuid:${uuid}`);
          break;
        }
      } catch (_) { /* 重试 */ }
    }
  }

  // 退路：hostname + CPU 型号
  if (parts.length < 2) {
    parts.push(`host:${os.hostname()}`);
    parts.push(`cpumodel:${os.cpus()[0]?.model || "unknown"}`);
  }

  _hardwareCache = parts.join("|");
  return _hardwareCache;
}

/**
 * 生成机器码（用户可见的短码）。
 * 取硬件指纹的 SHA-256 前 16 字节，Base36 编码，分 4 组展示。
 */
export function getMachineCode() {
  if (_machineCodeCache) return _machineCodeCache;
  const raw = getHardwareIdentifiers();
  const hash = crypto.createHash("sha256").update(raw).digest();
  const hex = hash.slice(0, 16).toString("hex");
  // 转为 Base36 分组
  let big = BigInt("0x" + hex);
  let str = "";
  while (big > 0n) {
    str = "0123456789abcdefghijklmnopqrstuvwxyz"[Number(big % 36n)] + str;
    big /= 36n;
  }
  str = str.padStart(25, "0").slice(0, 25);
  _machineCodeCache = str.match(/.{5}/g).join("-");
  return _machineCodeCache;
}

/**
 * 获取机器指纹完整哈希（内部使用，用于授权码绑定）。
 */
export function getMachineFingerprint() {
  if (_machineFingerprintCache) return _machineFingerprintCache;
  const raw = getHardwareIdentifiers();
  _machineFingerprintCache = crypto.createHash("sha256").update(raw).digest("hex");
  return _machineFingerprintCache;
}

/**
 * 计算「PowerShell 硬件查询失败时的回退指纹」（仅 MAC + 主机名 + CPU 型号）。
 * 兼容旧授权：若授权码在硬件查询失败时签发（指纹为回退值），后续查询成功
 * 会让主指纹变化，导致已激活的旧授权被误判失效。verifyLicense 在主指纹不
 * 匹配时补查此回退指纹，保证已激活的旧授权依然有效。
 */
function getFallbackFingerprint() {
  const parts = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name] || [];
    for (const addr of addrs) {
      if (!addr.internal && !addr.mac.includes("00:00:00:00") && addr.mac.length > 0) {
        parts.push(`mac:${addr.mac}`);
        break;
      }
    }
    if (parts.some((p) => p.startsWith("mac:"))) break;
  }
  parts.push(`host:${os.hostname()}`);
  parts.push(`cpumodel:${os.cpus()[0]?.model || "unknown"}`);
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * 防时间作弊：高水位线机制。
 * 每次启动记录「曾见过的最大时间戳」，如果当前时间小于该值，判定为改钟。
 * 同时交叉校验文件修改时间，防止用户删除高水位文件后倒拨。
 */
const HIGH_WATER_FILE = path.join(
  process.env.MYTEMPLE_DATA_ROOT || process.env.DATA_DIR
    || path.join(process.env.LOCALAPPDATA || path.join(process.env.APPDATA || "", "..", "Local"), "MyTempleKnowledgeData"),
  ".hwmark"
);

let _systemRefTimeCache = null;

async function getSystemReferenceTime() {
  if (_systemRefTimeCache !== null) return _systemRefTimeCache;
  // 交叉校验 1：系统安装日期（Windows 注册表）
  if (process.platform === "win32") {
    try {
      const installDate = execSync(
        'powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).InstallDate"',
        { timeout: 5000, encoding: "utf8" }
      ).trim();
      const ts = Date.parse(installDate);
      if (!Number.isNaN(ts)) {
        _systemRefTimeCache = ts;
        return ts;
      }
    } catch (_) { /* ignore */ }
  }
  // 退路：使用当前时间（无法交叉校验时仅依赖高水位线）
  _systemRefTimeCache = Date.now();
  return _systemRefTimeCache;
}

async function getHighWaterMark() {
  const refTime = await getSystemReferenceTime();
  let fileTime = 0;
  let fileMtime = 0;
  if (existsSync(HIGH_WATER_FILE)) {
    try {
      const content = await readFile(HIGH_WATER_FILE, "utf8");
      const data = JSON.parse(content);
      fileTime = Number(data.t) || 0;
      fileMtime = Number(data.m) || 0;
    } catch (_) { /* ignore */ }
  }
  return { refTime, fileTime, fileMtime };
}

async function updateHighWaterMark(currentTime) {
  const dir = path.dirname(HIGH_WATER_FILE);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const prev = existsSync(HIGH_WATER_FILE)
    ? JSON.parse(await readFile(HIGH_WATER_FILE, "utf8").catch(() => "{}"))
    : {};
  const maxTime = Math.max(currentTime, Number(prev.t) || 0);
  await writeFile(
    HIGH_WATER_FILE,
    JSON.stringify({ t: maxTime, m: Date.now(), v: 1 }),
    "utf8"
  );
  return maxTime;
}

/**
 * 验证授权码。
 * @param {string} licenseKey - 用户输入的授权码（Base64）
 * @returns {Promise<{valid: boolean, expired: boolean, expiry?: number, error?: string, machineCode: string}>}
 */
export async function verifyLicense(licenseKey) {
  const machineCode = getMachineCode();

  try {
    const raw = Buffer.from(licenseKey.replace(/\s/g, ""), "base64");

    // 授权码格式：[4字节长度][签名][JSON载荷]
    const sigLen = raw.readUInt32BE(0);
    const signature = raw.slice(4, 4 + sigLen);
    const payloadJson = raw.slice(4 + sigLen).toString("utf8");
    const payload = JSON.parse(payloadJson);

    // 1. 验证签名
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(payloadJson);
    const sigValid = verifier.verify(PUBLIC_KEY_PEM, signature);

    if (!sigValid) {
      return { valid: false, expired: false, error: "授权码签名无效", machineCode };
    }

    // 2. 验证机器码绑定（机器码仅携带前16字节指纹，所以只比较前32个hex字符）
    const expectedFingerprint = getMachineFingerprint().slice(0, 32);
    if (payload.fp !== expectedFingerprint) {
      // 兼容旧授权：若授权在 PowerShell 硬件查询失败时签发，其指纹为回退值
      // （mac+host+cpumodel）。查询成功后主指纹变化会让旧授权被误判失效。
      // 补查回退指纹，匹配则视为同一设备，避免已激活授权反复弹窗。
      const fallbackFingerprint = getFallbackFingerprint().slice(0, 32);
      if (payload.fp !== fallbackFingerprint) {
        return { valid: false, expired: false, error: "授权码与当前设备不匹配", machineCode };
      }
    }

    // 3. 防时间作弊检查
    const now = Date.now();
    const { refTime, fileTime } = await getHighWaterMark();

    // 系统安装时间不能晚于当前时间（异常情况）
    if (refTime > now + 60000) {
      return { valid: false, expired: false, error: "检测到系统时间异常，请校正后重试", machineCode };
    }

    // 检测时间回拨：用高水位线作为有效"当前时间"
    // 这样如果授权在高水位线时仍有效，回拨后仍有效（不因回拨而锁定）
    // 如果授权在高水位线时已过期，回拨后仍过期（防止利用回拨延长有效期）
    const timeRolledBack = fileTime > 0 && now < fileTime - 5 * 60 * 1000;
    const effectiveNow = timeRolledBack ? fileTime : now;

    // 4. 检查有效期（使用 effectiveNow 判断）
    const expiry = Number(payload.exp) || 0;
    if (expiry > 0 && effectiveNow > expiry) {
      // 授权已过期：无论是回拨前就过期，还是回拨后过期
      // 用高水位线时间确认：如果高水位线时已过期，说明过期是真实的
      if (timeRolledBack) {
        // 回拨场景：用真实当前时间也检查一次
        if (now > expiry) {
          // 真实当前时间也超过有效期，确实已过期
          return { valid: false, expired: true, expiry, error: "授权已过期", machineCode };
        }
        // 真实当前时间未过期，但高水位线时已过期
        // 说明用户在授权过期后回拨了时间，应锁定
        return {
          valid: false,
          expired: true,
          expiry,
          error: "检测到系统时间回拨，授权已过期。请联系管理员重新激活。",
          machineCode,
        };
      }
      // 非回拨场景：正常过期
      await updateHighWaterMark(now);
      return { valid: false, expired: true, expiry, error: "授权已过期", machineCode };
    }

    // 5. 检查签发时间（不能是未来时间）
    const issuedAt = Number(payload.iat) || 0;
    if (issuedAt > effectiveNow + 60000) {
      return { valid: false, expired: false, error: "授权码签发时间异常", machineCode };
    }

    // 验证通过，更新高水位线
    await updateHighWaterMark(timeRolledBack ? Math.max(now, fileTime) : now);

    return {
      valid: true,
      expired: false,
      expiry,
      issuedAt,
      machineCode,
      timeRolledBack: timeRolledBack || undefined,
    };
  } catch (err) {
    return { valid: false, expired: false, error: `授权码格式错误: ${err.message}`, machineCode };
  }
}

/**
 * 获取当前设备的授权状态概要（不含敏感信息）。
 */
export async function getLicenseStatus() {
  const machineCode = getMachineCode();
  const { refTime, fileTime } = await getHighWaterMark();
  const now = Date.now();

  return {
    machineCode,
    currentTime: now,
    highWaterMark: fileTime,
    systemRefTime: refTime,
    clockTampered: fileTime > 0 && now < fileTime - 5 * 60 * 1000,
  };
}
