import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// 记录文档浏览时间，用于「知识库智能管理」中的温习提醒。
// 持久化为 doc-views.json：{ "路径": { "viewedAt": 毫秒, "viewCount": 次数 } }
export class DocViewStore {
  constructor(dataRoot) {
    this.filePath = path.join(dataRoot, "doc-views.json");
    this.views = new Map();
    this.loaded = false;
    this.saveTimer = 0;
  }

  async load() {
    if (this.loaded) return;
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content || "{}");
      for (const [key, value] of Object.entries(parsed)) {
        this.views.set(key, {
          viewedAt: Number(value?.viewedAt) || 0,
          viewCount: Number(value?.viewCount) || 0,
        });
      }
    } catch {
      // 首次使用或文件损坏时静默初始化为空。
    }
    this.loaded = true;
  }

  record(docPath) {
    if (!docPath) return Promise.resolve();
    return this.load().then(() => {
      const existing = this.views.get(docPath) || { viewedAt: 0, viewCount: 0 };
      existing.viewedAt = Date.now();
      existing.viewCount += 1;
      this.views.set(docPath, existing);
      this.scheduleSave();
    }).catch(() => {});
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = 0;
      this.persist().catch(() => {});
    }, 800);
  }

  async persist() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const obj = {};
    for (const [key, value] of this.views) obj[key] = value;
    await writeFile(this.filePath, JSON.stringify(obj, null, 2), "utf8");
  }

  snapshot() {
    return new Map(this.views);
  }
}
