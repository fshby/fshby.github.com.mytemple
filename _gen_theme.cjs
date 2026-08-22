const fs = require('fs');
const lines = fs.readFileSync('public/styles.css', 'utf8').split(/\r?\n/);
// eye 块 L116-185 (0-indexed 115-184), glow 块 L187-256 (186-255)
const eyeBlock = lines.slice(115, 185);
const glowBlock = lines.slice(186, 256);

// 提取变量行（--xxx: yyy;）
const varLines = eyeBlock.filter((l) => /^\s*--[\w-]+:/.test(l));

// 提取 background 多行（从 "  background:" 到含 ";" 的行）
const extractMulti = (block, startRe) => {
  const out = [];
  let capturing = false;
  for (const l of block) {
    if (!capturing && startRe.test(l)) { capturing = true; out.push(l); if (/;\s*$/.test(l)) break; continue; }
    if (capturing) { out.push(l); if (/;\s*$/.test(l)) break; }
  }
  return out;
};
const eyeBg = extractMulti(eyeBlock, /^\s*background:/);
const glowBg = extractMulti(glowBlock, /^\s*background:/);
const eyeAttach = eyeBlock.filter((l) => /^\s*background-attachment:/.test(l));
const eyeLS = eyeBlock.filter((l) => /^\s*letter-spacing:/.test(l));
const eyeWFS = eyeBlock.filter((l) => /^\s*-webkit-font-smoothing:/.test(l));
const eyeMFS = eyeBlock.filter((l) => /^\s*-moz-osx-font-smoothing:/.test(l));
const eyeTR = eyeBlock.filter((l) => /^\s*text-rendering:/.test(l));
const glowComment = glowBlock.filter((l) => /^\s*\/\*/.test(l));

const IND = "  ";
const sharedBlock = [
  "body[data-theme=\"eye\"], body[data-theme=\"glow\"] {",
  ...varLines,
  ...eyeLS, ...eyeWFS, ...eyeMFS, ...eyeTR,
  "}"
];
const eyeNew = [
  "body[data-theme=\"eye\"] {",
  ...eyeBg,
  ...eyeAttach,
  "}"
];
const glowNew = [
  ...glowComment,
  "body[data-theme=\"glow\"] {",
  ...glowBg,
  ...eyeAttach,
  "}"
];
const newSeg = [...sharedBlock, "", ...eyeNew, "", ...glowNew].join("\n");

// 原片段（L116-256）用于比对长度
const oldSeg = lines.slice(115, 256).join("\n");
console.log("=== OLD (L116-256) lines=" + lines.slice(115,256).length + " ===");
console.log("=== NEW lines=" + newSeg.split("\n").length + " ===");
console.log("--- NEW CONTENT ---");
console.log(newSeg);
console.log("--- END ---");
console.log("varLines=" + varLines.length, "eyeBg=" + eyeBg.length, "glowBg=" + glowBg.length, "attach=" + eyeAttach.length, "glowComment=" + glowComment.length);
