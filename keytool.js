#!/usr/bin/env node

/**
 * MyTemple Knowledge - 授权码生成工具 (KeyTool)
 *
 * 使用方法：
 *   node keytool.js                          # 交互模式
 *   node keytool.js <机器码> <天数>           # 命令行模式
 *   node keytool.js ABCDE-12345-FGHIJ-KLMNO-PQRST 365
 *
 * 功能：
 *   1. 输入用户的机器码（由软件生成）
 *   2. 设置授权有效天数（如 365 = 一年，0 = 永久）
 *   3. 生成 RSA-SHA256 签名的授权码
 *   4. 用户将授权码填入软件即可激活
 *
 * 安全说明：
 *   - 私钥仅存在于此工具中，软件侧只有公钥
 *   - 授权码绑定机器指纹，无法跨设备使用
 *   - 内置防时间回拨机制，用户改钟无法延长有效期
 */

import crypto from "node:crypto";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * 内嵌私钥（对应软件中的公钥）
 * ⚠️ 此文件请妥善保管，切勿泄露或随软件分发！
 */
const PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCuKJkiRAam1SZ+
gqEyytzU+H1vIDSi0j9AJnNZ7+EAZdjWbyjumv896YdBoEpdFyHPZ661tAl7AQo1
y6LJQF0ufsqZCI6dVpVOiCSu1xlce5Yw6C4Rcnwqm1jVzI6ljZCmczS2TD4AD0EH
+nzSDQ67vjAAtCciCmlE3ehN2D4gxY6ukZYMIBh3UeLkRODUQTDWmyGxvURcvPdt
xztosUfTqB0pa+sVK7MfTRo79guy2/djgZ0FvwK0HYH+IVmmOkyVZrbIvmmftfy6
VOapTaH8y/q6VkxGUzUz9yU4CATYuQhrNUl+tuNFBBFTI9S+X5ZZezdVq24eNear
hsw7zAP/AgMBAAECggEAGub7jK78Zg379cPg+bMbfKxr19weNV6L1bF61RQ4afLR
lYIzTPRVZC9sLMeBZTLbDqpB8yB97GnDNX8gxLy0CCgezJflS8mho7FlFTr12HLg
xuo+n4RTSNOZW+FO0aT2CLg4FsbdNu4kSgK4AExzD643xQwPFXONQk2TAl9abX5F
Z5tNeQhOm9cPPEgKkfienJHAT7V8mMEEcumi0nC/cC7iGGANG/Lj1RM7i6HsewDi
vSRbjUWKszIAjkymSzUw0CmkdQgjG8TS0o7lMIg7qh31F9Z1SDvMDJjeSgTUqthL
RVVVTpPxJyNkkAg8mT37tj05tTCqvq/wpSYEFnwCsQKBgQDmynz6ctsAaXNLoLUg
26AHZVgt0CUeC8oYu0Z3x5CI9FyciQivv8aT/TuT6sOalxMsN0dgUk2mICTffVEe
23TqLYTie8c7R6pInAU4GYA50/kGdErdBFUx4tuaCtavG2q/JsP1X2cVFF0933V8
yv3LeEoxACfeizeVeT+1HiEurwKBgQDBLoWxP8hFM56pYvY7Zm/CoWmrz/LZUlyn
5o45VD0ozd0ToUgZNTQrkBf1FKi44Hm2f9a83k2XyH0ZGEgQ0W9KukIIhymtUNpj
6KhsO+MZRz33Zt3mrJCzIdjTL6SAxlJkfIC853UjCndRZi62lyfcC1w+JWhAc+KH
vV5clMhTsQKBgQCGKA6eR0Wm56VtwO2JPCG6Kt8nQmdRH+lKlxJPbmJGOkXbeIzk
HMaCICIRydYKdudePIPxKeaZOvY0M9SD62368prcTLdzbiU+L/OYuLog42dOqSsb
bvlXFlgxIzvIbleO5ini6KIzTrMk1FCnShhdvn7iHQUQCD03VlQCJJGFYQKBgQCJ
/I0KWqDWrVR7cXCoZTcXMuykCNlSWf5M/+Y/FOjKqKFtUBqLxvEI3Nf/+025IL5P
mWjtZ2zNKiwRLMLtIGv6WKiqJsGiRsp36svC49QHTlf4y8Vc645AJcEWuEUspnxb
woLCbCHDccpgnjhnu/iAuKyex2F8CEqa4qzwPGYLQQKBgQC/2s7YdIwHz1M3LwGB
a0q8V89Sn4zKB1F10Px0roosK7FxWo19/dj3WOp6Qq+JRhzoklL1fmz0Dot56Q7+
+KAXjR5kqGhH3q8DpsDEtLwia82xE78a7EPMq05OQNH3oTYVFH1+19+MBKx2jHBe
e5bcSJuxSYURHtkFSdjTkQfzGw==
-----END PRIVATE KEY-----`;

/**
 * 从机器码还原机器指纹哈希。
 * 机器码是指纹的 Base36 编码，keytool 无法逆向原始硬件信息，
 * 但可以将其转回十六进制指纹用于绑定授权码。
 */
function machineCodeToFingerprint(machineCode) {
  const clean = machineCode.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  // Base36 → BigInt → hex
  let big = 0n;
  for (const ch of clean) {
    big = big * 36n + BigInt("0123456789abcdefghijklmnopqrstuvwxyz".indexOf(ch));
  }
  let hex = big.toString(16);
  // 补齐到 32 字符（16 字节 = 32 hex）
  hex = hex.padStart(32, "0").slice(0, 32);
  return hex;
}

/**
 * 生成授权码。
 * @param {string} machineCode - 用户提供的机器码
 * @param {number} days - 授权有效天数（0 = 永久）
 * @returns {string} Base64 编码的授权码
 */
function generateLicense(machineCode, days) {
  const fingerprint = machineCodeToFingerprint(machineCode);
  const now = Date.now();
  const expiry = days > 0 ? now + days * 24 * 60 * 60 * 1000 : 0;

  const payload = {
    fp: fingerprint,
    iat: now,
    exp: expiry,
    days: days,
  };

  const payloadJson = JSON.stringify(payload);
  const signature = crypto.sign("RSA-SHA256", Buffer.from(payloadJson), PRIVATE_KEY_PEM);

  // 格式：[4字节签名长度][签名][JSON载荷]
  const sigLenBuf = Buffer.alloc(4);
  sigLenBuf.writeUInt32BE(signature.length, 0);
  const combined = Buffer.concat([sigLenBuf, signature, Buffer.from(payloadJson, "utf8")]);

  return combined.toString("base64");
}

/**
 * 格式化授权码为多行，便于阅读和输入。
 */
function formatLicenseKey(licenseKey) {
  const chunks = licenseKey.match(/.{1,48}/g) || [];
  return chunks.join("\n");
}

async function main() {
  const args = process.argv.slice(2);

  let machineCode, days;

  if (args.length >= 2) {
    machineCode = args[0];
    days = parseInt(args[1], 10);
  } else {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    console.log("╔══════════════════════════════════════════╗");
    console.log("║   MyTemple Knowledge - 授权码生成工具     ║");
    console.log("╚══════════════════════════════════════════╝");
    console.log("");

    machineCode = (await rl.question("请输入用户机器码: ")).trim();
    const daysInput = (await rl.question("授权天数（0=永久，默认365）: ")).trim();
    days = daysInput ? parseInt(daysInput, 10) : 365;
    rl.close();
  }

  if (!machineCode) {
    console.error("错误: 机器码不能为空");
    process.exit(1);
  }

  if (Number.isNaN(days) || days < 0) {
    console.error("错误: 天数必须是非负整数");
    process.exit(1);
  }

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`机器码: ${machineCode}`);
  console.log(`授权期限: ${days === 0 ? "永久" : days + " 天"}`);
  console.log(`签发时间: ${new Date().toLocaleString("zh-CN")}`);
  console.log(`过期时间: ${days === 0 ? "永不" : new Date(Date.now() + days * 86400000).toLocaleString("zh-CN")}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");

  const licenseKey = generateLicense(machineCode, days);

  console.log("授权码（整行复制给用户）:");
  console.log("");
  console.log(licenseKey);
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("请将上方授权码发送给用户，用户在软件中填入即可激活。");
}

main().catch((err) => {
  console.error("生成授权码失败:", err.message);
  process.exit(1);
});
