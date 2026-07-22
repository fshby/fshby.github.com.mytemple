const OWNED_FIELDS = ["schema", "title", "tags", "domain", "created", "updated", "status", "aliases"];
const STATUS_VALUES = new Set(["draft", "active", "archived"]);

function quoteYaml(value) {
  const text = String(value ?? "").trim();
  if (!text) return "\"\"";
  if (/^[\p{L}\p{N}_.\-/ ]+$/u.test(text) && !/^(?:true|false|null|yes|no|\d+(?:\.\d+)?)$/i.test(text)) return text;
  return JSON.stringify(text);
}

function parseScalar(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseInlineList(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  return text.slice(1, -1).split(",").map(parseScalar).map((item) => item.replace(/^#/, "")).filter(Boolean);
}

export function splitFrontmatter(markdown) {
  const source = String(markdown || "");
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { exists: false, raw: "", body: source, data: {} };
  const raw = match[1];
  const lines = raw.split(/\r?\n/);
  const data = {};
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^([A-Za-z_][\w.-]*):\s*(.*)$/);
    if (!field) continue;
    const key = field[1];
    const inline = parseInlineList(field[2]);
    if (inline) {
      data[key] = inline;
      continue;
    }
    if (field[2].trim()) {
      data[key] = parseScalar(field[2]);
      continue;
    }
    const values = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const list = lines[cursor].match(/^\s+-\s*(.*)$/);
      if (!list) break;
      values.push(parseScalar(list[1]).replace(/^#/, ""));
      cursor += 1;
    }
    if (values.length) {
      data[key] = values.filter(Boolean);
      index = cursor - 1;
    } else {
      data[key] = "";
    }
  }
  return { exists: true, raw, body: source.slice(match[0].length), data };
}

function preserveUnknownBlocks(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const kept = [];
  for (let index = 0; index < lines.length;) {
    const field = lines[index].match(/^([A-Za-z_][\w.-]*):/);
    if (!field || !OWNED_FIELDS.includes(field[1].toLowerCase())) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }
    index += 1;
    while (index < lines.length && (/^\s+/.test(lines[index]) || !lines[index].trim())) index += 1;
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept;
}

function cleanList(values, max = 20) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim().replace(/^#/, "")).filter(Boolean))].slice(0, max);
}

export function standardMetadata(markdown, options = {}) {
  const parsed = splitFrontmatter(markdown);
  const today = options.today || new Date().toISOString().slice(0, 10);
  const heading = parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = String(options.title || parsed.data.title || heading || "未命名文档").trim();
  const tags = cleanList(options.tags || parsed.data.tags || []);
  const aliases = cleanList(options.aliases || parsed.data.aliases || []);
  const statusCandidate = String(options.status || parsed.data.status || "active").toLowerCase();
  return {
    schema: "mytemple/v1",
    title,
    tags,
    domain: String(options.domain || parsed.data.domain || "未分类").trim() || "未分类",
    created: String(parsed.data.created || options.created || today).trim(),
    updated: String(options.updated || today).trim(),
    status: STATUS_VALUES.has(statusCandidate) ? statusCandidate : "active",
    aliases,
  };
}

function metadataLines(metadata) {
  const lines = [
    `schema: ${quoteYaml(metadata.schema)}`,
    `title: ${quoteYaml(metadata.title)}`,
  ];
  if (metadata.tags.length) lines.push("tags:", ...metadata.tags.map((tag) => `  - ${quoteYaml(tag)}`));
  else lines.push("tags: []");
  lines.push(
    `domain: ${quoteYaml(metadata.domain)}`,
    `created: ${quoteYaml(metadata.created)}`,
    `updated: ${quoteYaml(metadata.updated)}`,
    `status: ${metadata.status}`,
  );
  if (metadata.aliases.length) lines.push("aliases:", ...metadata.aliases.map((alias) => `  - ${quoteYaml(alias)}`));
  else lines.push("aliases: []");
  return lines;
}

export function normalizeFrontmatter(markdown, options = {}) {
  const source = String(markdown || "");
  const parsed = splitFrontmatter(source);
  const metadata = standardMetadata(source, options);
  const unknown = parsed.exists ? preserveUnknownBlocks(parsed.raw) : [];
  const lines = [...metadataLines(metadata), ...(unknown.length ? ["", ...unknown] : [])];
  const body = parsed.body.replace(/^\s+/, "");
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

export function createDocumentTemplate(name, today = new Date().toISOString().slice(0, 10)) {
  return normalizeFrontmatter(`# ${String(name || "未命名文档").trim()}\n\n`, {
    title: String(name || "未命名文档").trim(),
    tags: [],
    domain: "未分类",
    created: today,
    updated: today,
    status: "draft",
  });
}

export function frontmatterSummary(markdown) {
  const parsed = splitFrontmatter(markdown);
  const metadata = standardMetadata(markdown);
  const missing = OWNED_FIELDS.filter((field) => parsed.data[field] === undefined);
  return { exists: parsed.exists, metadata, missing, standard: parsed.exists && missing.length === 0 && parsed.data.schema === "mytemple/v1" };
}
