/**
 * 桌面端「云端同步」入口。
 *
 * 设计原则（刻意保守）：
 *  1. 完全自包含 —— 样式通过 <style> 注入，不写入 public/styles.css（那是构建产物，
 *     由 frontend/styles/ 的 5 个层文件合并而来，直接改会被 css-architecture 测试拦下）。
 *  2. 只做「入口 + 指引 + 状态」，不发起任何云端请求。原因是云服务的请求来源必须等于
 *     本应用的发布域名（服务端做精确 Origin 校验），桌面 WebView 的 127.0.0.1 源不在
 *     白名单内；真正的上传在云端工作台里完成，用户在那里显式选择要同步的文件夹。
 *  3. 不改动任何既有模块的行为：唯一改动是 initCloudSync() 往工具栏按钮上挂一个 click。
 */

/** 云端工作台地址（发布域名，与 cloud-config.js 中的 endpoint 同源）。 */
export const CLOUD_WORKBENCH_URL = "https://mytemple-cloud.app.workbuddy.host/";

const STYLE_ID = "mt-cloud-entry-style";
const PANEL_ID = "mtCloudPanel";
const TOAST_ID = "mtCloudToast";

/** 轻量提示：自包含实现，避免依赖 app.js 的模块作用域函数。 */
let toastTimer = null;
function notify(message) {
  let node = document.getElementById(TOAST_ID);
  if (!node) {
    node = document.createElement("div");
    node.id = TOAST_ID;
    node.className = "mt-cloud-toast";
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.add("is-open");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("is-open"), 3000);
}

const CSS = `
.mt-cloud-backdrop {
  position: fixed; inset: 0; z-index: 9000;
  background: rgba(24, 20, 14, .42);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.mt-cloud-panel {
  width: 100%; max-width: 520px; max-height: 86vh; overflow: auto;
  background: var(--surface-1, #fffdf8);
  color: var(--text, #3d3830);
  border: 1px solid var(--line, rgba(61,56,48,.15));
  border-radius: var(--radius-lg, 16px);
  box-shadow: var(--shadow-lg, 0 18px 48px rgba(40,34,24,.28));
  font-family: var(--app-font-family, inherit);
}
.mt-cloud-head {
  display: flex; align-items: center; gap: 10px;
  padding: 16px 18px 12px; border-bottom: 1px solid var(--line, rgba(61,56,48,.13));
}
.mt-cloud-head h2 { margin: 0; font-size: 16px; font-weight: 650; flex: 1 1 auto; }
.mt-cloud-close {
  border: none; background: none; font-size: 16px; line-height: 1; padding: 4px 6px;
  border-radius: 6px; color: var(--muted, #8a8175); cursor: pointer;
}
.mt-cloud-close:hover { background: var(--soft, rgba(61,56,48,.07)); }
.mt-cloud-body { padding: 16px 18px 20px; display: flex; flex-direction: column; gap: 14px; }
.mt-cloud-lead { margin: 0; font-size: 13.5px; line-height: 1.7; color: var(--text, #3d3830); }
.mt-cloud-facts {
  display: flex; flex-direction: column; gap: 6px;
  background: var(--soft, rgba(61,56,48,.05));
  border-radius: 10px; padding: 11px 13px; font-size: 12.5px;
}
.mt-cloud-fact { display: flex; gap: 10px; }
.mt-cloud-fact dt { color: var(--muted, #8a8175); min-width: 72px; margin: 0; }
.mt-cloud-fact dd { margin: 0; flex: 1 1 auto; word-break: break-all; }
.mt-cloud-actions { display: flex; gap: 9px; flex-wrap: wrap; }
.mt-cloud-btn {
  border: 1px solid var(--line-strong, rgba(61,56,48,.25));
  background: transparent; border-radius: 9px; padding: 9px 14px;
  font-size: 13.5px; cursor: pointer; color: inherit;
}
.mt-cloud-btn:hover { background: var(--soft, rgba(61,56,48,.07)); }
.mt-cloud-btn-primary {
  border-color: transparent; background: var(--accent-solid, #6b5f44);
  color: var(--on-accent, #fff); font-weight: 600;
}
.mt-cloud-btn-primary:hover { filter: brightness(1.08); background: var(--accent-solid, #6b5f44); }
.mt-cloud-steps { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.85; color: var(--text, #3d3830); }
.mt-cloud-note { margin: 0; font-size: 12px; line-height: 1.7; color: var(--muted, #8a8175); }
.mt-cloud-warn {
  margin: 0; font-size: 12px; line-height: 1.7;
  background: rgba(179,69,58,.09); color: #a03b31;
  border-radius: 9px; padding: 9px 11px;
}
.mt-cloud-toast {
  position: fixed; left: 50%; bottom: 34px; transform: translate(-50%, 10px);
  z-index: 9500; max-width: min(80vw, 460px);
  background: var(--text-strong, #262119); color: var(--bg, #faf7f2);
  padding: 9px 16px; border-radius: 999px; font-size: 13px; text-align: center;
  opacity: 0; pointer-events: none; transition: opacity .18s, transform .18s;
}
.mt-cloud-toast.is-open { opacity: 1; transform: translate(-50%, 0); }
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function gatherFacts() {
  const facts = { workspace: "—", root: "—", count: "—" };
  try {
    const ws = await api("/api/workspaces");
    const list = Array.isArray(ws?.workspaces) ? ws.workspaces : [];
    const def = list.find((w) => w.id === ws?.defaultWorkspaceId) || list[0];
    if (def) {
      facts.workspace = def.name || def.id || "—";
      facts.root = def.root || "—";
    }
  } catch (_) { /* 状态读取失败不影响入口可用 */ }
  try {
    const files = await api("/api/files");
    const arr = Array.isArray(files) ? files : [];
    const md = arr.filter((f) => /\.(md|markdown|txt)$/i.test(String(f?.path || "")));
    facts.count = md.length ? `${md.length} 篇 Markdown` : "暂无 Markdown";
  } catch (_) { /* 同上 */ }
  return facts;
}

async function openWorkbench() {
  try {
    await api("/api/open-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: CLOUD_WORKBENCH_URL }),
    });
  } catch (err) {
    try {
      window.open(CLOUD_WORKBENCH_URL, "_blank", "noopener,noreferrer");
    } catch (_) {
      notify("打开浏览器失败：" + CLOUD_WORKBENCH_URL);
    }
  }
}

async function copyRoot(root) {
  if (!root || root === "—") {
    notify("没有取到知识库路径");
    return;
  }
  try {
    await navigator.clipboard.writeText(root);
    notify("已复制知识库路径");
  } catch (_) {
    notify("复制失败，请手动选取：" + root);
  }
}

export async function openCloudPanel() {
  injectStyles();
  if (document.getElementById(PANEL_ID)) return;

  const backdrop = document.createElement("div");
  backdrop.className = "mt-cloud-backdrop";
  backdrop.id = PANEL_ID;
  backdrop.innerHTML = `
    <div class="mt-cloud-panel" role="dialog" aria-modal="true" aria-label="云端同步">
      <div class="mt-cloud-head">
        <h2>云端同步</h2>
        <button class="mt-cloud-close" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="mt-cloud-body">
        <p class="mt-cloud-lead">
          把知识库同步到云端后，可以在手机上快速查看与检索。内容按账号隔离 ——
          登录后你只能看到自己上传的部分。
        </p>
        <dl class="mt-cloud-facts">
          <div class="mt-cloud-fact"><dt>当前工作区</dt><dd data-fact="workspace">读取中…</dd></div>
          <div class="mt-cloud-fact"><dt>本机路径</dt><dd data-fact="root">读取中…</dd></div>
          <div class="mt-cloud-fact"><dt>可同步内容</dt><dd data-fact="count">读取中…</dd></div>
        </dl>
        <div class="mt-cloud-actions">
          <button class="mt-cloud-btn mt-cloud-btn-primary" type="button" data-act="open">打开云端工作台</button>
          <button class="mt-cloud-btn" type="button" data-act="copy">复制知识库路径</button>
        </div>
        <ol class="mt-cloud-steps">
          <li>点「打开云端工作台」，用手机号验证码或微信登录。</li>
          <li>在工作台点「上传」→「选择文件夹」，选中下面这个本机路径。</li>
          <li>勾选/确认后开始上传；之后重复上传只会传输内容有变化的文档。</li>
        </ol>
        <p class="mt-cloud-note">上传完全由你决定：不点上传，任何内容都不会离开本机。</p>
        <p class="mt-cloud-warn">
          需要说明的限制：受云服务的安全策略约束，接入请求必须来自应用的发布域名，
          因此桌面端不能直接发起上传 —— 上传动作在云端工作台里完成（可在同一台电脑上操作）。
        </p>
      </div>
    </div>`;

  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || e.target.closest(".mt-cloud-close")) close();
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.getAttribute("data-act") === "open") openWorkbench();
    if (btn.getAttribute("data-act") === "copy") copyRoot(backdrop.querySelector('[data-fact="root"]')?.textContent || "");
  });
  const onKey = (e) => {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
  };
  document.addEventListener("keydown", onKey);

  const facts = await gatherFacts();
  if (!document.body.contains(backdrop)) return;
  for (const [key, value] of Object.entries(facts)) {
    const node = backdrop.querySelector(`[data-fact="${key}"]`);
    if (node) node.textContent = value;
  }
}

export function initCloudSync() {
  injectStyles();
  const btn = document.querySelector("#cloudBtn");
  if (!btn) return;
  btn.addEventListener("click", () => { openCloudPanel(); });
  window.__mtOpenCloudPanel = openCloudPanel;
}
