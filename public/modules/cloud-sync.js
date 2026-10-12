/**
 * 桌面端「云端同步」面板。
 *
 * 设计原则：
 *  1. 完全自包含 —— 样式通过 <style> 注入，不写入 public/styles.css（那是构建产物，
 *     由 frontend/styles/ 的 5 个层文件合并而来，直接改会被 css-architecture 测试拦下）。
 *  2. **工具栏零新增控件**：所有能力都收进既有「云端」按钮打开的那个面板里。
 *     面板内部按登录态分两段：未登录给紧凑登录表单，已登录给同步动作。
 *  3. 真正的网络与同步逻辑都在 ./cloud-client.js，本文件只负责界面与状态机。
 *
 * 关于「桌面端能不能直连云」：早期实现假设云服务强制「请求来源 == 发布域名」，
 * 因此只敢把用户引导到浏览器里去操作。该前提已被实测推翻（跨源预检对
 * http://127.0.0.1:<port> 完全放行），详见 cloud-client.js 头部注释。
 */

import {
  CLOUD_WORKBENCH_URL,
  cloudReady,
  getSession,
  sendOtp,
  verifyOtp,
  signInWithPassword,
  signOut,
  maskIdentity,
  syncCloud,
  summarize,
  lastSyncAt,
  readLocalIndex,
} from "./cloud-client.js";

export { CLOUD_WORKBENCH_URL };

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
  toastTimer = setTimeout(() => node.classList.remove("is-open"), 3200);
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
.mt-cloud-btn:disabled { opacity: .55; cursor: default; }
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
.mt-cloud-warn[hidden] { display: none; }
.mt-cloud-ok {
  margin: 0; font-size: 12px; line-height: 1.7;
  background: rgba(90,120,80,.12); color: #4d6b45;
  border-radius: 9px; padding: 9px 11px;
}
.mt-cloud-ok[hidden] { display: none; }
.mt-cloud-tabs { display: flex; gap: 6px; }
.mt-cloud-tab {
  border: 1px solid var(--line, rgba(61,56,48,.18));
  background: transparent; border-radius: 999px; padding: 5px 14px;
  font-size: 12.5px; cursor: pointer; color: var(--muted, #8a8175);
}
.mt-cloud-tab.is-active {
  color: var(--on-accent, #fff); background: var(--accent-solid, #6b5f44);
  border-color: transparent; font-weight: 600;
}
.mt-cloud-field { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--muted, #8a8175); }
.mt-cloud-field[hidden] { display: none; }
.mt-cloud-field input {
  font: inherit; font-size: 13.5px; color: var(--text, #3d3830);
  background: var(--surface-0, #fff); border: 1px solid var(--line, rgba(61,56,48,.2));
  border-radius: 8px; padding: 8px 10px;
}
.mt-cloud-field input:focus { outline: 2px solid var(--accent, #6b5f44); outline-offset: -1px; }
.mt-cloud-row { display: flex; gap: 8px; align-items: flex-end; }
.mt-cloud-row .mt-cloud-field { flex: 1 1 auto; }
.mt-cloud-form { display: flex; flex-direction: column; gap: 11px; }
.mt-cloud-form[hidden] { display: none; }
.mt-cloud-link {
  border: none; background: none; padding: 0; cursor: pointer;
  font-size: 12.5px; color: var(--accent, #6b5f44); text-align: left;
  text-decoration: underline; align-self: flex-start;
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

function fmtTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startCountdown(btn, seconds = 60) {
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  let left = seconds;
  btn.disabled = true;
  btn.textContent = `${left}s 后重发`;
  const timer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = original;
      return;
    }
    btn.textContent = `${left}s 后重发`;
  }, 1000);
}

/** 本机服务端口：桌面 WebView 就加载在 http://127.0.0.1:<port>，所以 location.port 即真实端口。 */
function localPort() {
  const p = window.location.port;
  return /^\d{2,5}$/.test(p) ? p : "7321";
}

async function openWorkbench(withLocal) {
  const url = withLocal
    ? `${CLOUD_WORKBENCH_URL}?local=${encodeURIComponent(`http://127.0.0.1:${localPort()}`)}`
    : CLOUD_WORKBENCH_URL;
  try {
    await api("/api/open-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  } catch (err) {
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (_) {
      notify("打开浏览器失败：" + url);
    }
  }
}

async function copyText(text, okMessage) {
  if (!text || text === "—") {
    notify("没有可复制的内容");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    notify(okMessage);
  } catch (_) {
    notify("复制失败，请手动选取：" + text);
  }
}

export async function openCloudPanel() {
  injectStyles();
  if (document.getElementById(PANEL_ID)) return;

  const ready = cloudReady();
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
        <!-- 未登录 -->
        <section data-sec="auth">
          <p class="mt-cloud-lead">
            登录后，本机知识库可以与手机端、网页端互通。内容按账号隔离 ——
            登录后你只能看到自己账号下的内容。
          </p>
          <div class="mt-cloud-tabs">
            <button class="mt-cloud-tab is-active" type="button" data-tab="email">邮箱</button>
            <button class="mt-cloud-tab" type="button" data-tab="phone">手机号</button>
          </div>
          <form class="mt-cloud-form" data-form="email" style="margin-top:11px">
            <label class="mt-cloud-field">邮箱
              <input type="email" autocomplete="email" data-in="email" placeholder="you@example.com" />
            </label>
            <div class="mt-cloud-row" data-row="otp">
              <label class="mt-cloud-field">验证码
                <input inputmode="numeric" autocomplete="one-time-code" data-in="emailCode" placeholder="6 位数字" />
              </label>
              <button class="mt-cloud-btn" type="button" data-act="sendEmailCode">获取验证码</button>
            </div>
            <label class="mt-cloud-field" data-row="password" hidden>密码
              <input type="password" autocomplete="current-password" data-in="emailPassword" placeholder="至少 8 位" />
            </label>
            <button class="mt-cloud-btn mt-cloud-btn-primary" type="submit" data-act="emailSubmit">登录 / 注册</button>
            <button class="mt-cloud-link" type="button" data-act="toggleEmailPwd">改用密码登录</button>
          </form>
          <form class="mt-cloud-form" data-form="phone" hidden style="margin-top:11px">
            <label class="mt-cloud-field">手机号
              <input inputmode="tel" autocomplete="tel" data-in="phone" placeholder="11 位手机号" />
            </label>
            <div class="mt-cloud-row">
              <label class="mt-cloud-field">验证码
                <input inputmode="numeric" autocomplete="one-time-code" data-in="phoneCode" placeholder="6 位数字" />
              </label>
              <button class="mt-cloud-btn" type="button" data-act="sendPhoneCode">获取验证码</button>
            </div>
            <label class="mt-cloud-field" data-row="phonePassword" hidden>密码
              <input type="password" data-in="phonePassword" placeholder="首次登录需设置，至少 8 位" />
            </label>
            <button class="mt-cloud-btn mt-cloud-btn-primary" type="submit" data-act="phoneSubmit">登录 / 注册</button>
          </form>
          <p class="mt-cloud-note" style="margin-top:11px">
            微信登录需要跳转浏览器、回调落在网页版，请在手机端或网页版使用。
          </p>
          <p class="mt-cloud-warn" data-err hidden></p>
        </section>

        <!-- 已登录 -->
        <section data-sec="main" hidden>
          <dl class="mt-cloud-facts">
            <div class="mt-cloud-fact"><dt>登录账号</dt><dd data-fact="who">读取中…</dd></div>
            <div class="mt-cloud-fact"><dt>上次同步</dt><dd data-fact="last">尚未同步</dd></div>
            <div class="mt-cloud-fact"><dt>工作区</dt><dd data-fact="workspace">读取中…</dd></div>
            <div class="mt-cloud-fact"><dt>本机路径</dt><dd data-fact="root">读取中…</dd></div>
            <div class="mt-cloud-fact"><dt>可同步内容</dt><dd data-fact="count">读取中…</dd></div>
          </dl>
          <div class="mt-cloud-actions">
            <button class="mt-cloud-btn mt-cloud-btn-primary" type="button" data-act="pull">拉取云端更新</button>
            <button class="mt-cloud-btn" type="button" data-act="push">推送本机 → 云端</button>
            <button class="mt-cloud-btn" type="button" data-act="open">打开网页版</button>
          </div>
          <p class="mt-cloud-note" data-progress></p>
          <p class="mt-cloud-ok" data-result hidden></p>
          <p class="mt-cloud-note">
            拉取不会覆盖本机：两端都改过的会保留本机版本，云端版本另存为
            <code>.conflict-云-时间.md</code>。云端删除也只提示，不会删本机文件。
          </p>
          <p class="mt-cloud-note">
            不想让桌面端直接上传时，也可以在浏览器里打开云端页并让它读取本机
            （只读接口，写操作不开放）：
            <button class="mt-cloud-link" type="button" data-act="open-local">用浏览器读取本机（只读）</button>
          </p>
          <p class="mt-cloud-note">
            本机服务端口 <b data-fact="port"></b>；登录态按「域名 + 端口」保存，
            端口变化时需要重新登录。
          </p>
          <div class="mt-cloud-actions">
            <button class="mt-cloud-btn" type="button" data-act="copy">复制本机路径</button>
            <button class="mt-cloud-btn" type="button" data-act="logout">退出登录</button>
          </div>
        </section>
      </div>
    </div>`;

  document.body.appendChild(backdrop);

  const $ = (sel, root = backdrop) => root.querySelector(sel);
  const $$ = (sel, root = backdrop) => [...root.querySelectorAll(sel)];
  const secAuth = $('[data-sec="auth"]');
  const secMain = $('[data-sec="main"]');
  const errBox = $("[data-err]");
  const progress = $("[data-progress]");
  const resultBox = $("[data-result]");

  const setError = (msg) => {
    errBox.textContent = msg || "";
    errBox.hidden = !msg;
  };
  const setProgress = (msg) => { progress.textContent = msg || ""; };
  const setResult = (msg) => {
    resultBox.textContent = msg || "";
    resultBox.hidden = !msg;
  };

  let emailMode = "otp"; // "otp" | "password"
  let pendingEmail = null;
  let pendingPhone = null;

  function setEmailMode(mode) {
    emailMode = mode;
    const isPwd = mode === "password";
    const pwdRow = $('[data-row="password"]');
    $('[data-row="otp"]').hidden = isPwd;
    pwdRow.hidden = isPwd ? false : pwdRow.dataset.forced !== "1";
    $('[data-act="sendEmailCode"]').disabled = isPwd;
    $('[data-act="emailSubmit"]').textContent = isPwd ? "登录" : "登录 / 注册";
    $('[data-act="toggleEmailPwd"]').textContent = isPwd ? "改用验证码登录" : "改用密码登录";
  }
  setEmailMode("otp");

  function showTab(tab) {
    for (const b of $$("[data-tab]")) b.classList.toggle("is-active", b.dataset.tab === tab);
    $('[data-form="email"]').hidden = tab !== "email";
    $('[data-form="phone"]').hidden = tab !== "phone";
    setError("");
  }

  async function gatherFacts() {
    const facts = { workspace: "—", root: "—", count: "—" };
    try {
      const { ws, files } = await readLocalIndex();
      if (ws) {
        facts.workspace = ws.name || ws.id || "—";
        facts.root = ws.root || "—";
      }
      facts.count = files.length ? `${files.length} 篇 Markdown / 文本` : "暂无 Markdown";
    } catch (_) {
      /* 状态读取失败不影响入口可用 */
    }
    return facts;
  }

  async function refresh() {
    const session = await getSession();
    if (!document.body.contains(backdrop)) return;
    const signedIn = !!(session && session.user);
    secAuth.hidden = signedIn;
    secMain.hidden = !signedIn;
    if (!signedIn) {
      $('[data-fact="who"]').textContent = "读取中…";
      return;
    }
    $('[data-fact="who"]').textContent = maskIdentity(session.user);
    $('[data-fact="port"]').textContent = localPort();
    const facts = await gatherFacts();
    if (!document.body.contains(backdrop)) return;
    for (const [key, value] of Object.entries(facts)) {
      const node = $(`[data-fact="${key}"]`);
      if (node) node.textContent = value;
    }
    const last = lastSyncAt(facts.workspace === "—" ? null : facts.workspace) || lastSyncAt(null);
    $('[data-fact="last"]').textContent = last ? fmtTime(last) : "尚未同步";
  }

  /* ── 事件 ── */
  // 表单一律拦截原生提交：面板是内联弹层，真提交会把 WebView 导航走
  for (const f of $$("form")) f.addEventListener("submit", (e) => e.preventDefault());

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || e.target.closest(".mt-cloud-close")) {
      backdrop.remove();
      return;
    }
    const tab = e.target.closest("[data-tab]");
    if (tab) { showTab(tab.dataset.tab); return; }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    handleAction(btn).catch((err) => setError(String((err && err.message) || err)));
  });

  async function handleAction(btn) {
    const act = btn.dataset.act;
    setError("");
    setResult("");

    if (act === "toggleEmailPwd") {
      setEmailMode(emailMode === "password" ? "otp" : "password");
      return;
    }

    if (act === "sendEmailCode") {
      const email = $('[data-in="email"]').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setError("请输入正确的邮箱地址"); return; }
      btn.disabled = true;
      try {
        const info = await sendOtp({ email });
        pendingEmail = { email, ...info };
        const pwdRow = $('[data-row="password"]');
        pwdRow.dataset.forced = info.isExistingUser ? "" : "1";
        pwdRow.hidden = info.isExistingUser;
        startCountdown(btn);
        notify(info.isExistingUser ? "验证码已发送到邮箱" : "验证码已发送，新邮箱需设置密码");
      } catch (err) {
        btn.disabled = false;
        setError(String((err && err.message) || err));
      }
      return;
    }

    if (act === "sendPhoneCode") {
      const phone = $('[data-in="phone"]').value.trim();
      if (!/^1\d{10}$/.test(phone)) { setError("请输入正确的 11 位手机号"); return; }
      btn.disabled = true;
      try {
        const info = await sendOtp({ phone });
        pendingPhone = { phone, ...info };
        $('[data-row="phonePassword"]').hidden = info.isExistingUser;
        startCountdown(btn);
        notify("验证码已发送");
      } catch (err) {
        btn.disabled = false;
        setError(String((err && err.message) || err));
      }
      return;
    }

    if (act === "emailSubmit" || act === "phoneSubmit") {
      btn.disabled = true;
      try {
        if (act === "emailSubmit" && emailMode === "password") {
          const email = $('[data-in="email"]').value.trim();
          const password = $('[data-in="emailPassword"]').value;
          if (!email || !password) { setError("请填写邮箱与密码"); return; }
          await signInWithPassword(email, password);
        } else if (act === "emailSubmit") {
          const email = $('[data-in="email"]').value.trim();
          const token = $('[data-in="emailCode"]').value.trim();
          if (!pendingEmail || pendingEmail.email !== email) { setError("请先为当前邮箱获取验证码"); return; }
          if (!token) { setError("请输入验证码"); return; }
          const password = $('[data-in="emailPassword"]').value;
          if (!pendingEmail.isExistingUser && String(password).length < 8) {
            setError("首次注册需要设置密码（至少 8 位）"); return;
          }
          await verifyOtp({
            email, verificationId: pendingEmail.verificationId,
            isExistingUser: pendingEmail.isExistingUser, token,
            password: pendingEmail.isExistingUser ? undefined : password,
          });
          pendingEmail = null;
        } else {
          const phone = $('[data-in="phone"]').value.trim();
          const token = $('[data-in="phoneCode"]').value.trim();
          if (!pendingPhone || pendingPhone.phone !== phone) { setError("请先为当前手机号获取验证码"); return; }
          if (!token) { setError("请输入验证码"); return; }
          const password = $('[data-in="phonePassword"]').value;
          if (!pendingPhone.isExistingUser && String(password).length < 8) {
            setError("首次登录需要设置密码（至少 8 位）"); return;
          }
          await verifyOtp({
            phone, verificationId: pendingPhone.verificationId,
            isExistingUser: pendingPhone.isExistingUser, token,
            password: pendingPhone.isExistingUser ? undefined : password,
          });
          pendingPhone = null;
        }
        notify("已登录");
        await refresh();
      } finally {
        btn.disabled = false;
      }
      return;
    }

    if (act === "logout") {
      await signOut();
      setProgress("");
      setResult("");
      notify("已退出登录");
      await refresh();
      return;
    }

    if (act === "copy") {
      await copyText($('[data-fact="root"]').textContent || "", "已复制本机路径");
      return;
    }

    if (act === "open") {
      await openWorkbench(false);
      return;
    }

    if (act === "open-local") {
      // 备用路径：把本机只读地址交给云端页（它自己去读 /api/workspaces、/api/files）。
      // 写接口一个都不开放，见 handlers.rs::cloud_read_cors。
      await openWorkbench(true);
      return;
    }

    if (act === "push" || act === "pull") {
      const buttons = $$('[data-act="push"], [data-act="pull"]');
      for (const b of buttons) b.disabled = true;
      setResult("");
      try {
        const summary = await syncCloud({
          mode: act === "push" ? "push" : "pull",
          onProgress: (t) => setProgress(t),
        });
        setProgress("");
        const line = summarize(summary);
        setResult(line);
        notify(line, summary.failed ? "error" : undefined);
        if (summary.notes.length) console.info("[cloud-sync]", summary.notes.join("\n"));
        if (summary.push || summary.pull || summary.conflict || summary.tombstone) {
          // 本机文件被写入过 → 让主界面重新扫描树与计数
          try { window.__mtReloadFromCloud && window.__mtReloadFromCloud(); } catch (_) {}
        }
        const last = lastSyncAt(summary.workspace);
        $('[data-fact="last"]').textContent = last ? fmtTime(last) : "刚刚";
      } finally {
        for (const b of buttons) b.disabled = false;
      }
      return;
    }
  }

  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input")) {
      const form = e.target.closest("form");
      const submit = form && form.querySelector('button[type="submit"]');
      if (submit) { e.preventDefault(); handleAction(submit).catch((err) => setError(String((err && err.message) || err))); }
    }
  });

  const onKey = (e) => {
    if (e.key === "Escape") { backdrop.remove(); document.removeEventListener("keydown", onKey); }
  };
  document.addEventListener("keydown", onKey);

  if (!ready) {
    setError("云服务 SDK 或配置未加载，请确认安装完整后重启应用。");
  }
  await refresh();
}

/**
 * 初始化：给工具栏既有的「云端」按钮挂上打开面板的行为。
 * `options.reload` 由宿主传入（app.js 的 bootstrap），用于同步写回本机后刷新界面。
 */
export function initCloudSync(options = {}) {
  injectStyles();
  if (typeof options.reload === "function") {
    window.__mtReloadFromCloud = options.reload;
  }
  const btn = document.querySelector("#cloudBtn");
  if (!btn) return;
  btn.addEventListener("click", () => { openCloudPanel(); });
  window.__mtOpenCloudPanel = openCloudPanel;
}
