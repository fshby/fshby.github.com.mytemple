import { escapeHtml } from "./path-utils.js";

// 代码语法高亮关键词表（按语言），仅 highlightCode 使用。
const CODE_KEYWORDS = {
  javascript: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|delete|void|yield|async|await|try|catch|finally|throw|import|export|from|default|as|static|get|set|null|undefined|true|false|NaN|Infinity)\b/g,
  typescript: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|delete|void|yield|async|await|try|catch|finally|throw|import|export|from|default|as|static|get|set|null|undefined|true|false|NaN|Infinity|interface|type|enum|namespace|declare|abstract|readonly|public|private|protected|implements|keyof|infer|is)\b/g,
  python: /\b(?:def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|try|except|finally|raise|with|lambda|yield|global|nonlocal|assert|del|in|not|and|or|is|None|True|False|self|cls|async|await)\b/g,
  go: /\b(?:func|return|if|else|for|range|switch|case|default|break|continue|var|const|type|struct|interface|map|chan|package|import|defer|go|select|fallthrough|goto|nil|true|false)\b/g,
  rust: /\b(?:fn|let|mut|const|static|struct|enum|trait|impl|pub|use|mod|return|if|else|match|for|while|loop|break|continue|as|in|ref|move|async|await|unsafe|extern|crate|self|Self|super|type|where|dyn|union)\b/g,
  java: /\b(?:public|private|protected|static|final|void|class|interface|extends|implements|return|if|else|for|while|do|switch|case|break|continue|new|this|super|try|catch|finally|throw|throws|import|package|instanceof|synchronized|abstract|enum|null|true|false|int|long|double|float|boolean|char|byte|short|String)\b/g,
  c: /\b(?:int|long|short|char|float|double|void|unsigned|signed|const|static|extern|register|volatile|auto|struct|union|enum|typedef|return|if|else|for|while|do|switch|case|break|continue|default|goto|sizeof|NULL|true|false|include|define|ifdef|ifndef|endif)\b/g,
  cpp: /\b(?:int|long|short|char|float|double|void|unsigned|signed|const|static|extern|register|volatile|auto|struct|union|enum|class|namespace|template|typename|public|private|protected|virtual|override|return|if|else|for|while|do|switch|case|break|continue|default|goto|sizeof|new|delete|this|nullptr|true|false|include|define|ifdef|ifndef|endif|using|operator)\b/g,
  csharp: /\b(?:public|private|protected|static|readonly|const|void|class|interface|struct|enum|extends|implements|return|if|else|for|while|do|switch|case|break|continue|new|this|base|try|catch|finally|throw|using|namespace|var|dynamic|async|await|get|set|value|null|true|false|int|long|double|float|bool|char|string|byte|object|override|virtual|abstract|sealed)\b/g,
  ruby: /\b(?:def|end|class|module|return|if|elsif|else|unless|case|when|while|until|for|break|next|redo|retry|yield|begin|rescue|ensure|raise|require|require_relative|include|extend|attr_accessor|attr_reader|attr_writer|self|super|nil|true|false|lambda|do|then)\b/g,
  bash: /\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|break|continue|exit|local|export|unset|read|echo|printf|source|alias|unalias|trap|set|unset|shift|cd|pwd|ls|cat|grep|sed|awk|find|chmod|chown|mkdir|rmdir|rm|cp|mv|touch|head|tail|wc|sort|uniq|cut|tr|tee|xargs)\b/g,
  powershell: /\b(?:param|function|return|if|else|elseif|switch|for|foreach|while|do|break|continue|try|catch|finally|throw|using|namespace|class|enum|var|Write-Output|Write-Host|Write-Error|Get-ChildItem|Set-Location|Get-Content|New-Item|Remove-Item|Copy-Item|Move-Item|Select-Object|Where-Object|ForEach-Object|Sort-Object|Format-Table|Out-String|Invoke-WebRequest)\b/g,
  sql: /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|VIEW|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|ON|GROUP|BY|HAVING|ORDER|ASC|DESC|LIMIT|OFFSET|UNION|ALL|DISTINCT|AS|AND|OR|NOT|IN|EXISTS|BETWEEN|LIKE|IS|NULL|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|CONSTRAINT|UNIQUE|CHECK|CASCADE|TRIGGER|PROCEDURE|FUNCTION|RETURNS|DECLARE|BEGIN|COMMIT|ROLLBACK|TRANSACTION)\b/gi,
  json: /\b(?:true|false|null)\b/g,
  yaml: /\b(?:true|false|null|yes|no|on|off)\b/g,
  html: /\b(?:html|head|body|div|span|p|a|img|ul|ol|li|table|tr|td|th|thead|tbody|form|input|button|label|select|option|textarea|h1|h2|h3|h4|h5|h6|br|hr|meta|link|script|style|title|nav|header|footer|main|section|article|aside|figure|figcaption|code|pre|blockquote)\b/gi,
};

const BUILTIN_TYPES = /\b(?:string|number|boolean|object|array|Promise|Date|RegExp|Error|Map|Set|Symbol|BigInt|Uint8Array|ArrayBuffer|JSON|Math|console|window|document|process|Buffer|require|module|exports|global|window|setTimeout|setInterval|clearTimeout|clearInterval|fetch|console)\b/g;

// 轻量代码语法高亮：依次标注注释/字符串/数字/关键字/内建类型/函数调用/HTML 标签，纯函数。
export function highlightCode(raw, language) {
  let code = escapeHtml(raw);
  const lang = String(language || "text").toLowerCase();

  // 1. Comments (highest priority - protect from further matching)
  const commentSpans = [];
  code = code.replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)/g, (match) => {
    const idx = commentSpans.length;
    commentSpans.push(`<span class="tok-comment">${match}</span>`);
    return `\x00C${idx}\x00`;
  });

  // 2. Strings
  const stringSpans = [];
  code = code.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, (match) => {
    const idx = stringSpans.length;
    stringSpans.push(`<span class="tok-string">${match}</span>`);
    return `\x00S${idx}\x00`;
  });

  // 3. Numbers
  code = code.replace(/\b(\d+\.?\d*(?:e[+-]?\d+)?|0x[0-9a-fA-F]+|0b[01]+)\b/g, '<span class="tok-number">$1</span>');

  // 4. Keywords
  const kwPattern = CODE_KEYWORDS[lang] || CODE_KEYWORDS.javascript;
  code = code.replace(kwPattern, (match) => `<span class="tok-keyword">${match}</span>`);

  // 5. Built-in types & globals (only for JS/TS family)
  if (["javascript", "typescript", "json"].includes(lang)) {
    code = code.replace(BUILTIN_TYPES, (match) => `<span class="tok-builtin">${match}</span>`);
  }

  // 6. Function calls: word followed by (
  code = code.replace(/\b([a-zA-Z_$][\w$]*)(\s*\()/g, (match, name, paren) => {
    if (match.includes("span class=")) return match;
    return `<span class="tok-function">${name}</span>${paren}`;
  });

  // 7. HTML/XML tags (for html, xml, markdown)
  if (["html", "xml", "markdown"].includes(lang)) {
    code = code.replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="tok-tag">$2</span>');
    code = code.replace(/\s([\w-]+)(=)/g, ' <span class="tok-attr">$1</span>$2');
  }

  // Restore strings
  code = code.replace(/\x00S(\d+)\x00/g, (_, idx) => stringSpans[Number(idx)] || "");
  // Restore comments
  code = code.replace(/\x00C(\d+)\x00/g, (_, idx) => commentSpans[Number(idx)] || "");

  return code;
}
