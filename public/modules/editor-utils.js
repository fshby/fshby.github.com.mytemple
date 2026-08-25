import { headingId, plainText } from "./path-utils.js";

// 从 Markdown 源码提取大纲（标题 + 自动识别的中文序号/数字序号标题），纯函数。
export function extractOutline(source) {
  const outline = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  let h1Index = 0;
  let h2Index = 0;
  let h3Index = 0;
  let h4Index = 0;
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo];
    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const heading = line.match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[2].length;
      if (level > 3) continue; // 4级及以下小标题不纳入大纲
      let index;
      if (level === 1) {
        index = h1Index++;
        h2Index = 0;
        h3Index = 0;
        h4Index = 0;
      } else if (level === 2) {
        index = `sub-${h2Index++}`;
        h3Index = 0;
        h4Index = 0;
      } else if (level === 3) {
        index = `h3-${h3Index++}`;
        h4Index = 0;
      } else {
        index = `h4-${h4Index++}`;
      }
      outline.push({ id: headingId(heading[3], index), title: plainText(heading[3]), level, line: lineNo });
      continue;
    }
    const autoHeading = line.match(/^(\s*)([一二三四五六七八九十]{1,4}[、.．]\s*.+)$/);
    if (autoHeading) {
      const level = 2;
      outline.push({ id: headingId(autoHeading[2], `auto-${h2Index++}`), title: plainText(autoHeading[2]), level, line: lineNo });
      h3Index = 0;
      h4Index = 0;
      continue;
    }
    const dottedHeading = line.match(/^(\s*)(\d+(?:\.\d+)+)[、.．]\s*([^-*].+)$/);
    if (dottedHeading) {
      const level = 3;
      outline.push({ id: headingId(dottedHeading[3], `num-h3-${h3Index++}`), title: plainText(dottedHeading[3]), level, line: lineNo });
      h4Index = 0;
      continue;
    }

    const numHeading = line.match(/^(\s*)(\((?:\d{1,3})\)|(\d{1,3})([、.．)]))\s*([^-*].+)$/);
    if (numHeading && !/^\s*\d+[.)]\s+\[[ xX]\](?:\s|$)/.test(line)) {
      const level = 4;
      continue; // 4级数字标题也不纳入大纲
      // 以下代码已废弃，仅为保持逻辑参考
      // outline.push({ id: headingId(numHeading[5], `num-h4-${h4Index++}`), title: plainText(numHeading[5]), level, line: lineNo });
    }
  }
  return outline;
}

// 中英文之间自动补空格，纯函数。
export function addCnEnSpaces(text) {
  let result = text;
  result = result.replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, "$1 $2");
  result = result.replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, "$1 $2");
  result = result.replace(/([\u4e00-\u9fa5])\s+([，。！？；：、）》】])/g, "$1$2");
  result = result.replace(/([（《【])\s+([\u4e00-\u9fa5])/g, "$1$2");
  return result;
}
