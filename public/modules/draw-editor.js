// draw-editor.js — 轻量 Canvas 绘图器
// 保存格式为 Excalidraw 兼容 JSON，与现有 ````excalidraw` 代码块无缝互通。
// 功能：矩形 / 圆形 / 菱形 / 箭头 / 直线 / 文字 / 自由画笔
//       颜色 / 填充 / 线宽 / 撤销 / 重做 / 清空
// 零依赖，100% 离线可用。

// ── Excalidraw JSON 辅助 ──────────────────────────────────

let _seed = Date.now() & 0xffffffff;
function nextSeed() { _seed = (_seed * 1664525 + 1013904223) & 0xffffffff; return _seed; }
function randId() {
  const a = Math.random().toString(36).slice(2, 10);
  const b = Math.random().toString(36).slice(2, 10);
  return a + b;
}
function nowMs() { return Date.now(); }

function baseElement(type, x, y, extra = {}) {
  return {
    id: randId(),
    type,
    x, y,
    width: 0, height: 0,
    angle: 0,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type === "rectangle" || type === "arrow" || type === "line" ? { type: 3 } : null,
    seed: nextSeed(),
    version: 1,
    versionNonce: nextSeed(),
    isDeleted: false,
    boundElements: null,
    updated: nowMs(),
    link: null,
    locked: false,
    ...extra,
  };
}

function rectElement(x, y, w, h, extra = {}) {
  const el = baseElement("rectangle", x, y, extra);
  el.width = w; el.height = h;
  if (w < 0) { el.x = x + w; el.width = -w; }
  if (h < 0) { el.y = y + h; el.height = -h; }
  return el;
}
function ellipseElement(cx, cy, w, h, extra = {}) {
  const el = baseElement("ellipse", cx, cy, extra);
  el.width = Math.abs(w); el.height = Math.abs(h);
  return el;
}
function diamondElement(cx, cy, w, h, extra = {}) {
  const el = baseElement("diamond", cx, cy, extra);
  el.width = Math.abs(w); el.height = Math.abs(h);
  return el;
}
function lineElement(x1, y1, x2, y2, extra = {}) {
  const el = baseElement("line", Math.min(x1, x2), Math.min(y1, y2), extra);
  el.width = Math.abs(x2 - x1); el.height = Math.abs(y2 - y1);
  el.points = [[0, 0], [x2 - x1, y2 - y1]];
  el.lastCommittedPoint = null;
  return el;
}
function arrowElement(x1, y1, x2, y2, extra = {}) {
  const el = baseElement("arrow", Math.min(x1, x2), Math.min(y1, y2), extra);
  el.width = Math.abs(x2 - x1); el.height = Math.abs(y2 - y1);
  el.points = [[0, 0], [x2 - x1, y2 - y1]];
  el.lastCommittedPoint = null;
  el.startBinding = null;
  el.endBinding = null;
  el.startArrowhead = null;
  el.endArrowhead = "arrow";
  return el;
}
function textElement(x, y, text, extra = {}) {
  const el = baseElement("text", x, y, extra);
  el.text = text || "";
  el.fontSize = extra.fontSize || 20;
  el.fontFamily = extra.fontFamily || 1; // 1 = Virgil, 3 = Helvetica
  el.textAlign = extra.textAlign || "left";
  el.baseline = extra.baseline || 5; // 5 = middle
  el.lineHeight = extra.lineHeight || 1.25;
  el.originalText = text || "";
  el.autoResize = true;
  const metrics = measureText(text || "", el.fontSize);
  el.width = metrics.width; el.height = metrics.height;
  return el;
}
function freedrawElement(points, extra = {}) {
  const xs = points.map(p => p[0]); const ys = points.map(p => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const el = baseElement("freedraw", minX, minY, extra);
  el.points = points.map(p => [p[0] - minX, p[1] - minY]);
  el.width = Math.max(...xs) - minX;
  el.height = Math.max(...ys) - minY;
  el.lastCommittedPoint = null;
  el.simulatePressure = true;
  el.pressure = points.map(() => 0.5);
  return el;
}

function measureText(text, fontSize) {
  // 粗略估算：中文每个字 fontSize×1.0，英文每个字 fontSize×0.6
  const chars = [...(text || "")];
  let w = 0;
  for (const c of chars) {
    w += /[\u4e00-\u9fff]/.test(c) ? fontSize : fontSize * 0.6;
  }
  return { width: Math.max(4, w), height: fontSize * 1.25 };
}

// ── 绘图核心 ──────────────────────────────────────────────

const TOOLS = ["select", "rectangle", "ellipse", "diamond", "arrow", "line", "text", "freedraw"];
const TOOL_LABEL = {
  select: "选择", rectangle: "矩形", ellipse: "圆形", diamond: "菱形",
  arrow: "箭头", line: "直线", text: "文字", freedraw: "画笔",
};

const COLORS = [
  "#000000", "#e03131", "#2f9e44", "#1971c2", "#7048e8", "#f08c00", "#868e96",
  "#ffffff", "#ffe066", "#51cf66", "#74c0fc", "#b197fc", "#ffd43b", "#dee2e6",
];

class DrawEditor {
  constructor() {
    this.elements = [];
    this.tool = "select";
    this.strokeColor = "#000000";
    this.bgColor = "transparent";
    this.strokeWidth = 2;
    this.fontSize = 20;
    this.pointer = { x: 0, y: 0, down: false };
    this.drawing = null;          // 正在绘制的临时元素
    this.selected = new Set();    // 选中元素 id
    this.dragOffset = null;       // 拖拽时的偏移
    this.undoStack = [];
    this.redoStack = [];
    this.onSave = null;
    this.onCancel = null;
    this.canvas = null;
    this.ctx = null;
    this.dpr = window.devicePixelRatio || 1;
  }

  // ── 初始化 UI ────────────────────────────────────────

  mount(container) {
    const wrap = document.createElement("div");
    wrap.className = "draw-modal-overlay";
    wrap.innerHTML = `
      <div class="draw-modal" style="display:flex;flex-direction:column;width:min(1200px,96vw);height:min(720px,92vh);background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;">
        <div class="draw-toolbar" style="display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid #e5e7eb;background:#fafbfc;flex-wrap:wrap;">
          ${TOOLS.map(t => `<button class="draw-tool" data-tool="${t}" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">${TOOL_LABEL[t]}</button>`).join("")}
          <span style="width:1px;height:20px;background:#e5e7eb;margin:0 4px;"></span>
          <label style="font-size:12px;color:#6b7280;">颜色</label>
          <input type="color" class="draw-color" value="${this.strokeColor}" style="width:32px;height:28px;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;">
          <label style="font-size:12px;color:#6b7280;">填充</label>
          <input type="color" class="draw-bgcolor" value="${this.bgColor}" style="width:32px;height:28px;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;">
          <span style="width:1px;height:20px;background:#e5e7eb;margin:0 4px;"></span>
          <label style="font-size:12px;color:#6b7280;">线宽</label>
          <select class="draw-width" style="padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;background:#fff;">
            <option value="1" ${this.strokeWidth===1?"selected":""}>1</option>
            <option value="2" ${this.strokeWidth===2?"selected":""}>2</option>
            <option value="4" ${this.strokeWidth===4?"selected":""}>4</option>
            <option value="6" ${this.strokeWidth===6?"selected":""}>6</option>
          </select>
          <label style="font-size:12px;color:#6b7280;">字号</label>
          <select class="draw-fontsize" style="padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;background:#fff;">
            ${[12,14,16,18,20,24,28,32,40,48].map(s => `<option value="${s}" ${this.fontSize===s?"selected":""}>${s}</option>`).join("")}
          </select>
          <span style="width:1px;height:20px;background:#e5e7eb;margin:0 4px;"></span>
          <button class="draw-undo" title="撤销 (Ctrl+Z)" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">↩ 撤销</button>
          <button class="draw-redo" title="重做 (Ctrl+Y)" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">↪ 重做</button>
          <button class="draw-delete" title="删除选中 (Delete)" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">🗑 删除</button>
          <button class="draw-clear" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">清空</button>
          <div style="flex:1"></div>
          <button class="draw-cancel" style="padding:8px 16px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">取消</button>
          <button class="draw-save" style="padding:8px 16px;border:none;border-radius:6px;background:#10b981;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">保存</button>
        </div>
        <div class="draw-canvas-wrap" style="flex:1;position:relative;background:#fafbfc;overflow:auto;">
          <canvas class="draw-canvas" style="display:block;width:4000px;height:4000px;background:#ffffff;cursor:crosshair;"></canvas>
        </div>
        <div class="draw-status" style="padding:4px 12px;border-top:1px solid #e5e7eb;background:#fafbfc;font-size:12px;color:#6b7280;">
          工具: <span class="draw-tool-label">${TOOL_LABEL[this.tool]}</span> · 已选 ${this.selected.size} 个元素 · 共 ${this.elements.length} 个元素
        </div>
      </div>
    `;

    // 基础样式
    const style = document.createElement("style");
    style.textContent = `
      .draw-modal-overlay { position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center; }
      .draw-tool.active { background:#10b981 !important; color:#fff; border-color:#10b981 !important; }
      .draw-tool:hover { background:#f3f4f6; }
      .draw-tool.active:hover { background:#059669 !important; }
    `;
    wrap.appendChild(style);
    container.appendChild(wrap);

    this.el = wrap;
    this.canvas = wrap.querySelector(".draw-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.toolLabel = wrap.querySelector(".draw-tool-label");
    this.statusBar = wrap.querySelector(".draw-status");

    this.resize();

    // 工具栏事件
    wrap.addEventListener("click", (e) => {
      const toolBtn = e.target.closest(".draw-tool");
      if (toolBtn) {
        this.setTool(toolBtn.dataset.tool);
        return;
      }
      if (e.target.closest(".draw-save")) { this.save(); return; }
      if (e.target.closest(".draw-cancel")) { this.cancel(); return; }
      if (e.target.closest(".draw-undo")) { this.undo(); return; }
      if (e.target.closest(".draw-redo")) { this.redo(); return; }
      if (e.target.closest(".draw-delete")) { this.deleteSelected(); return; }
      if (e.target.closest(".draw-clear")) { this.clearAll(); return; }
    });

    wrap.querySelector(".draw-color").addEventListener("input", (e) => { this.strokeColor = e.target.value; });
    wrap.querySelector(".draw-bgcolor").addEventListener("input", (e) => { this.bgColor = e.target.value; });
    wrap.querySelector(".draw-width").addEventListener("change", (e) => { this.strokeWidth = parseInt(e.target.value); });
    wrap.querySelector(".draw-fontsize").addEventListener("change", (e) => { this.fontSize = parseInt(e.target.value); });

    // Canvas 事件
    this.canvas.addEventListener("mousedown", (e) => this.onPointerDown(e));
    this.canvas.addEventListener("mousemove", (e) => this.onPointerMove(e));
    this.canvas.addEventListener("mouseup", (e) => this.onPointerUp(e));
    this.canvas.addEventListener("mouseleave", (e) => this.onPointerUp(e));
    // 双击已选文字元素 → 重新 inline 编辑
    this.canvas.addEventListener("dblclick", (e) => this.onDblClick(e));

    // 键盘事件
    this._onKeydown = (e) => this.onKeydown(e);
    document.addEventListener("keydown", this._onKeydown);

    // 阻止 overlay 内右键菜单
    wrap.addEventListener("contextmenu", (e) => e.preventDefault());

    // 点击 overlay 空白处：若正在编辑 inline text，先 blur 提交
    this._onDocClick = (e) => {
      if (this._textEditor && !this._textEditor.contains(e.target) && !this.canvas.contains(e.target)) {
        this.commitInlineText();
      }
    };
    document.addEventListener("mousedown", this._onDocClick, true);

    window.addEventListener("resize", () => this.resize());

    this.setTool("select");
    this.render();
  }

  resize() {
    // 大画布模式：canvas 固定 4000×4000，外层 wrap 负责滚动
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.dpr;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewW = rect.width;
    this.viewH = rect.height;
    this.render();
  }

  setTool(tool) {
    this.tool = tool;
    this.selected.clear();
    this.updateToolbar();
    this.render();
  }

  updateToolbar() {
    this.el.querySelectorAll(".draw-tool").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tool === this.tool);
    });
    this.toolLabel.textContent = TOOL_LABEL[this.tool];
    this.canvas.style.cursor = this.tool === "select" ? "default" : (this.tool === "freedraw" ? "crosshair" : "crosshair");
  }

  getPointer(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ── 交互 ──────────────────────────────────────────────

  // 返回选中元素的 8 个控制点坐标（{tl,t,tr,l,r,bl,b,br}）。
  // 非 text/freedraw 类型可缩放；line/arrow 仅端点可拖拽（暂不支持）。
  selectionHandles(el) {
    const box = this.elementBBox(el);
    const h = 6; // handle 正方形半边长（像素）
    return {
      tl: [box.x, box.y],
      t:  [box.x + box.w / 2, box.y],
      tr: [box.x + box.w, box.y],
      l:  [box.x, box.y + box.h / 2],
      r:  [box.x + box.w, box.y + box.h / 2],
      bl: [box.x, box.y + box.h],
      b:  [box.x + box.w / 2, box.y + box.h],
      br: [box.x + box.w, box.y + box.h],
      _half: h,
      _box: box,
    };
  }

  hitHandle(p, el) {
    // 仅对可缩放类型返回命中的 handle key
    const scalable = ["rectangle", "ellipse", "diamond", "text", "line", "arrow"];
    if (!scalable.includes(el.type)) return null;
    const hs = this.selectionHandles(el);
    const keys = ["tl", "t", "tr", "l", "r", "bl", "b", "br"];
    for (const k of keys) {
      const [hx, hy] = hs[k];
      if (Math.abs(p.x - hx) <= hs._half + 2 && Math.abs(p.y - hy) <= hs._half + 2) return k;
    }
    return null;
  }

  // 控制点 → 光标样式
  handleCursor(key) {
    const map = { tl: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize", br: "nwse-resize",
      t: "ns-resize", b: "ns-resize", l: "ew-resize", r: "ew-resize" };
    return map[key] || "default";
  }

  onPointerDown(e) {
    const p = this.getPointer(e);
    this.pointer = { ...p, down: true };
    this.canvas.focus();

    if (this.tool === "select") {
      // 先提交可能存在的 inline text 编辑（避免 mousedown 被 _onDocClick 拦截）
      if (this._textEditor) this.commitInlineText();

      // 检查是否点中了已选元素的控制点 → 进入 resize 模式
      let hitHandleKey = null;
      let hitEl = null;
      // 只对已选中的元素检查 handle；若多选，只对第一个检查
      if (this.selected.size === 1) {
        const firstId = [...this.selected][0];
        hitEl = this.elements.find(el => el.id === firstId);
        if (hitEl) hitHandleKey = this.hitHandle(p, hitEl);
      }

      if (hitHandleKey && hitEl) {
        // 进入 resize 模式
        this._resizing = { el: hitEl, handle: hitHandleKey, startX: p.x, startY: p.y };
        this._snapshotBefore();
        return;
      }

      // 尝试选中元素
      const hit = this.hitTest(p.x, p.y);
      this.selected.clear();
      if (hit) {
        this.selected.add(hit.id);
        const rect = this.elementBBox(hit);
        this.dragOffset = { dx: p.x - rect.x, dy: p.y - rect.y };
      }
      this.render();
      return;
    }

    if (this.tool === "text") {
      // 先提交可能存在的 inline text 编辑
      if (this._textEditor) this.commitInlineText();
      this.startInlineText(p.x, p.y, "");
      return;
    }

    // 其他工具开始绘制
    this._snapshotBefore();
    const extra = { strokeColor: this.strokeColor, backgroundColor: this.bgColor, strokeWidth: this.strokeWidth };

    if (this.tool === "rectangle") {
      this.drawing = { startX: p.x, startY: p.y, el: rectElement(p.x, p.y, 0, 0, extra) };
    } else if (this.tool === "ellipse") {
      this.drawing = { startX: p.x, startY: p.y, el: ellipseElement(p.x, p.y, 0, 0, extra) };
    } else if (this.tool === "diamond") {
      this.drawing = { startX: p.x, startY: p.y, el: diamondElement(p.x, p.y, 0, 0, extra) };
    } else if (this.tool === "arrow") {
      this.drawing = { startX: p.x, startY: p.y, el: arrowElement(p.x, p.y, p.x, p.y, extra) };
    } else if (this.tool === "line") {
      this.drawing = { startX: p.x, startY: p.y, el: lineElement(p.x, p.y, p.x, p.y, extra) };
    } else if (this.tool === "freedraw") {
      // 起点 = 当前鼠标位置（不是画布左上角 [0,0]），避免每次绘制都从左上角射出。
      this.drawing = { points: [[p.x, p.y]], el: freedrawElement([[p.x, p.y]], extra) };
    }
    this.render();
  }

  onPointerMove(e) {
    const p = this.getPointer(e);
    const prev = this.pointer;
    this.pointer = { ...p, down: prev.down };

    // resize 模式优先处理（优先级高于普通 move）
    if (this.tool === "select" && this._resizing) {
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      this.resizeElementByHandle(this._resizing.el, this._resizing.handle, dx, dy);
      this.render();
      return;
    }

    if (this.tool === "select" && prev.down && this.selected.size > 0 && this.dragOffset) {
      // 拖拽移动
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      this.elements.forEach(el => {
        if (this.selected.has(el.id)) this.moveElement(el, dx, dy);
      });
      this.render();
      return;
    }

    // 光标样式：hover 选中元素时显示 handle 光标
    if (this.tool === "select" && !prev.down) {
      // 先测 handle
      let hoverCursor = "default";
      if (this.selected.size === 1) {
        const firstId = [...this.selected][0];
        const el = this.elements.find(x => x.id === firstId);
        if (el) {
          const k = this.hitHandle(p, el);
          if (k) hoverCursor = this.handleCursor(k);
        }
      }
      // 再测元素（如果没选中，hover 时 cursor 保持 default）
      this.canvas.style.cursor = hoverCursor;
      // 继续下面的绘制逻辑
    }

    if (!prev.down || !this.drawing) return;

    if (this.tool === "rectangle") {
      this.drawing.el = rectElement(this.drawing.startX, this.drawing.startY, p.x - this.drawing.startX, p.y - this.drawing.startY, this.drawing.el);
    } else if (this.tool === "ellipse") {
      this.drawing.el = ellipseElement((this.drawing.startX + p.x) / 2, (this.drawing.startY + p.y) / 2, Math.abs(p.x - this.drawing.startX), Math.abs(p.y - this.drawing.startY), this.drawing.el);
    } else if (this.tool === "diamond") {
      this.drawing.el = diamondElement((this.drawing.startX + p.x) / 2, (this.drawing.startY + p.y) / 2, Math.abs(p.x - this.drawing.startX), Math.abs(p.y - this.drawing.startY), this.drawing.el);
    } else if (this.tool === "arrow") {
      this.drawing.el = arrowElement(this.drawing.startX, this.drawing.startY, p.x, p.y, this.drawing.el);
    } else if (this.tool === "line") {
      this.drawing.el = lineElement(this.drawing.startX, this.drawing.startY, p.x, p.y, this.drawing.el);
    } else if (this.tool === "freedraw") {
      this.drawing.points.push([p.x, p.y]);
      this.drawing.el = freedrawElement(this.drawing.points, this.drawing.el);
    }
    this.render();
  }

  onPointerUp(e) {
    this.pointer.down = false;
    if (this._resizing) {
      // 提交 resize：确保 undoStack 有快照
      this._resizing = null;
      this.redoStack = [];
      this.render();
      return;
    }
    if (this.drawing) {
      // 提交绘制
      if (this.drawing.el.width > 2 || this.drawing.el.height > 2 || this.tool === "freedraw") {
        this.elements.push(this.drawing.el);
        this.undoStack.push([...this.elements]);
        if (this.undoStack.length > 50) this.undoStack.shift();
        this.redoStack = [];
      } else {
        // 太小了视为误操作，撤回 snapshot
        this.undoStack.pop();
      }
      this.drawing = null;
      this.dragOffset = null;
      this.render();
    }
  }

  // ── 文字 inline 编辑 ───────────────────────────────────

  /** 在画布上直接创建一个可编辑的 textarea，用户实时输入文字。 */
  startInlineText(x, y, initialText, existingElId = null) {
    // 清理已有编辑器
    if (this._textEditor) this.commitInlineText();

    const ta = document.createElement("textarea");
    ta.value = initialText || "";
    ta.placeholder = "输入文字…\nEnter 提交";
    ta.style.cssText = `
      position: absolute;
      left: ${x}px; top: ${y}px;
      min-width: 120px; min-height: ${this.fontSize + 8}px;
      border: 1px dashed #10b981;
      border-radius: 4px;
      padding: 2px 6px;
      font-size: ${this.fontSize}px;
      font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      color: ${this.strokeColor};
      background: rgba(255,255,255,.7);
      outline: none;
      resize: both;
      overflow: hidden;
      z-index: 100;
      line-height: 1.25;
      white-space: pre-wrap;
    `;
    const wrap = this.canvas.parentElement;
    wrap.appendChild(ta);
    this._textEditor = ta;
    this._textAnchor = { x, y };
    this._textEditingElId = existingElId;
    this._snapshotBefore();

    // 自动调整高度
    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    });
    // Enter 提交（Shift+Enter 换行）
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.commitInlineText();
      } else if (e.key === "Escape") {
        this.cancelInlineText();
      }
      e.stopPropagation();
    });
    // 聚焦
    setTimeout(() => { ta.focus(); ta.select(); }, 0);
  }

  commitInlineText() {
    if (!this._textEditor) return;
    const ta = this._textEditor;
    const text = (ta.value || "").trim();
    const x = this._textAnchor.x;
    const y = this._textAnchor.y;
    this._textEditor = null;
    this._textAnchor = null;

    if (!text) {
      // 空文字 → 撤回 snapshot（如果有），无元素新增
      if (typeof this._textEditingElId === "string") {
        // 编辑已有元素但内容清空 → 删除
        this.elements = this.elements.filter(el => el.id !== this._textEditingElId);
        this.selected.delete(this._textEditingElId);
        this.undoStack.push([...this.elements]);
        this.redoStack = [];
      }
      this._textEditingElId = null;
      try { ta.remove(); } catch (_) {}
      this.render();
      return;
    }

    if (typeof this._textEditingElId === "string") {
      // 编辑已有文字元素 → 更新
      const el = this.elements.find(e => e.id === this._textEditingElId);
      if (el) {
        el.text = text;
        el.originalText = text;
        const metrics = measureText(text, el.fontSize);
        el.width = metrics.width;
        el.height = metrics.height;
      }
      this.selected.delete(this._textEditingElId);
    } else {
      // 新建文字元素
      const extra = { strokeColor: this.strokeColor, backgroundColor: this.bgColor, strokeWidth: this.strokeWidth, fontSize: this.fontSize };
      const el = textElement(x, y, text, extra);
      this.elements.push(el);
      this.selected.add(el.id);
    }
    this._textEditingElId = null;
    this.undoStack.push([...this.elements]);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    try { ta.remove(); } catch (_) {}
    this.render();
  }

  cancelInlineText() {
    if (!this._textEditor) return;
    const ta = this._textEditor;
    this._textEditor = null;
    this._textAnchor = null;
    this._textEditingElId = null;
    this.undoStack.pop(); // 撤回 snapshot
    try { ta.remove(); } catch (_) {}
    this.render();
  }

  /** 双击：在选择模式下，若命中文字元素则 inline 编辑它。 */
  onDblClick(e) {
    if (this.tool !== "select") return;
    const p = this.getPointer(e);
    const hit = this.hitTest(p.x, p.y);
    if (hit && hit.type === "text") {
      this.selected.clear();
      this.selected.add(hit.id);
      this.startInlineText(hit.x, hit.y, hit.text || "", hit.id);
    }
  }

  // ── 元素操作 ──────────────────────────────────────────

  elementBBox(el) {
    if (el.type === "text") return { x: el.x, y: el.y, w: el.width, h: el.height };
    if (el.type === "line" || el.type === "arrow") {
      const pts = el.points;
      const xs = pts.map(p => el.x + p[0]); const ys = pts.map(p => el.y + p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    if (el.type === "freedraw") {
      const pts = el.points;
      const xs = pts.map(p => el.x + p[0]); const ys = pts.map(p => el.y + p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    if (el.type === "ellipse" || el.type === "diamond") {
      return { x: el.x - el.width / 2, y: el.y - el.height / 2, w: el.width, h: el.height };
    }
    return { x: el.x, y: el.y, w: el.width, h: el.height };
  }

  moveElement(el, dx, dy) {
    el.x += dx; el.y += dy;
    if (el.points) el.points = el.points.map(p => [p[0], p[1]]); // 相对坐标，不变
  }

  hitTest(x, y) {
    // 从后往前找（后画的在上层）
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const el = this.elements[i];
      if (this.pointInElement(x, y, el)) return el;
    }
    return null;
  }

  pointInElement(x, y, el) {
    const box = this.elementBBox(el);
    if (el.type === "ellipse") {
      const cx = el.x, cy = el.y, rx = el.width / 2, ry = el.height / 2;
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      return dx * dx + dy * dy <= 1;
    }
    if (el.type === "diamond") {
      const cx = el.x, cy = el.y, rx = el.width / 2, ry = el.height / 2;
      return Math.abs(x - cx) / rx + Math.abs(y - cy) / ry <= 1;
    }
    if (el.type === "line" || el.type === "arrow") {
      // 点到线段距离
      const p = el.points;
      const x1 = el.x + p[0][0], y1 = el.y + p[0][1];
      const x2 = el.x + p[1][0], y2 = el.y + p[1][1];
      const dist = pointToLine(x, y, x1, y1, x2, y2);
      return dist <= 6;
    }
    if (el.type === "freedraw") {
      // 简单 bbox + 点到路径距离
      if (x < box.x - 4 || x > box.x + box.w + 4 || y < box.y - 4 || y > box.y + box.h + 4) return false;
      for (let i = 1; i < el.points.length; i++) {
        const p0 = el.points[i - 1]; const p1 = el.points[i];
        const d = pointToLine(x, y, el.x + p0[0], el.y + p0[1], el.x + p1[0], el.y + p1[1]);
        if (d <= 8) return true;
      }
      return false;
    }
    // rectangle / text：bbox 包含
    return x >= box.x - 2 && x <= box.x + box.w + 2 && y >= box.y - 2 && y <= box.y + box.h + 2;
  }

  // ── 撤销/重做 ─────────────────────────────────────────

  _snapshotBefore() {
    // 记录当前状态以便撤销后恢复
    this._before = JSON.parse(JSON.stringify(this.elements));
  }
  undo() {
    if (this.undoStack.length <= 1) return;
    const current = this.undoStack.pop();
    this.redoStack.push(current);
    this.elements = this.undoStack.length > 0 ? [...this.undoStack[this.undoStack.length - 1]] : [];
    this.selected.clear();
    this.render();
  }
  redo() {
    if (this.redoStack.length === 0) return;
    const next = this.redoStack.pop();
    this.undoStack.push(next);
    this.elements = [...next];
    this.selected.clear();
    this.render();
  }
  deleteSelected() {
    if (this.selected.size === 0) return;
    this._snapshotBefore();
    this.elements = this.elements.filter(el => !this.selected.has(el.id));
    this.selected.clear();
    this.undoStack.push([...this.elements]);
    this.redoStack = [];
    this.render();
  }
  clearAll() {
    if (this.elements.length === 0) return;
    if (!confirm("确认清空所有元素？")) return;
    this.elements = [];
    this.selected.clear();
    this.undoStack.push([]);
    this.redoStack = [];
    this.render();
  }

  // ── 控制点缩放 ──────────────────────────────────────────

  /** 根据 handle 方向和 dx/dy 更新元素尺寸。支持 rectangle / ellipse / diamond / text / line / arrow */
  resizeElementByHandle(el, handle, dx, dy) {
    if (!["rectangle", "ellipse", "diamond", "text", "line", "arrow"].includes(el.type)) return;

    if (el.type === "line" || el.type === "arrow") {
      // line/arrow：调整起点或终点
      const pts = el.points;
      if (handle === "l" || handle === "tl" || handle === "bl") {
        // 改起点
        pts[0] = [pts[0][0] + dx, pts[0][1] + dy];
      } else if (handle === "r" || handle === "tr" || handle === "br") {
        pts[pts.length - 1] = [pts[pts.length - 1][0] + dx, pts[pts.length - 1][1] + dy];
      } else if (handle === "t") {
        pts[0] = [pts[0][0], pts[0][1] + dy];
      } else if (handle === "b") {
        pts[pts.length - 1] = [pts[pts.length - 1][0], pts[pts.length - 1][1] + dy];
      }
      // 更新 x/y/width/height（相对元素原点）
      const xs = pts.map(p => p[0]);
      const ys = pts.map(p => p[1]);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      const maxX = Math.max(...xs), maxY = Math.max(...ys);
      const oldX = el.x, oldY = el.y;
      el.x += minX; el.y += minY;
      el.width = maxX - minX; el.height = maxY - minY;
      // 修正 points（现在相对于新原点）
      const ox = el.x - oldX, oy = el.y - oldY;
      for (let i = 0; i < pts.length; i++) { pts[i] = [pts[i][0] - minX, pts[i][1] - minY]; }
      return;
    }

    // rectangle / ellipse / diamond / text
    let { x, y, width, height } = el;
    if (handle === "tl") { x += dx; y += dy; width -= dx; height -= dy; }
    else if (handle === "t") { y += dy; height -= dy; }
    else if (handle === "tr") { y += dy; width += dx; height -= dy; }
    else if (handle === "l") { x += dx; width -= dx; }
    else if (handle === "r") { width += dx; }
    else if (handle === "bl") { x += dx; width -= dx; height += dy; }
    else if (handle === "b") { height += dy; }
    else if (handle === "br") { width += dx; height += dy; }

    // ellipse/diamond 中心点保持不变，调整 width/height
    if (el.type === "ellipse" || el.type === "diamond") {
      const cx = el.x, cy = el.y;
      const nw = Math.max(4, Math.abs(width));
      const nh = Math.max(4, Math.abs(height));
      el.width = nw; el.height = nh;
      // 反推中心：如果 handle 是 tl/l/t，则中心移动
      let cx2 = cx, cy2 = cy;
      if (handle.includes("l")) cx2 -= (width - nw) / 2;
      if (handle.includes("r")) cx2 += (nw - width) / 2;
      if (handle.includes("t")) cy2 -= (height - nh) / 2;
      if (handle.includes("b")) cy2 += (nh - height) / 2;
      el.x = cx2; el.y = cy2;
      return;
    }

    // rectangle / text：保证 width/height 为正，反转 x/y
    width = Math.max(4, width); height = Math.max(4, height);
    if (width < 0) { x = x + width; width = -width; }
    if (height < 0) { y = y + height; height = -height; }
    el.x = x; el.y = y; el.width = width; el.height = height;

    // text：重新计算 metrics
    if (el.type === "text") {
      const metrics = measureText(el.text || "", el.fontSize);
      el.width = metrics.width;
      el.height = metrics.height;
    }
  }

  // ── 键盘事件 ──────────────────────────────────────────

  onKeydown(e) {
    if (!this.el.contains(document.activeElement) && !this.el.matches(":focus-within") && document.activeElement !== document.body && !this._modalHasFocus()) {
      // 只在编辑器有焦点时响应
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); this.undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); this.redo(); }
    else if (e.key === "Delete" || e.key === "Backspace") { this.deleteSelected(); }
    else if (e.key === "Escape") { this.cancel(); }
    else if (e.key === "Enter" && this.selected.size === 0) { /* noop */ }
    else if (e.key === "1") this.setTool("select");
    else if (e.key === "2") this.setTool("rectangle");
    else if (e.key === "3") this.setTool("ellipse");
    else if (e.key === "4") this.setTool("diamond");
    else if (e.key === "5") this.setTool("arrow");
    else if (e.key === "6") this.setTool("line");
    else if (e.key === "7") this.setTool("text");
    else if (e.key === "8") this.setTool("freedraw");
  }

  _modalHasFocus() {
    // 如果 overlay 存在且 canvas/toolbar 有焦点，响应快捷键
    return this.el && (this.canvas === document.activeElement || this.el.contains(document.activeElement));
  }

  // ── 渲染 ──────────────────────────────────────────────

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.viewW, this.viewH);

    // 背景网格（浅色，方便对齐）
    ctx.save();
    ctx.strokeStyle = "#f0f1f3";
    ctx.lineWidth = 1;
    const grid = 20;
    for (let x = 0; x <= this.viewW; x += grid) {
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, this.viewH); ctx.stroke();
    }
    for (let y = 0; y <= this.viewH; y += grid) {
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(this.viewW, y + 0.5); ctx.stroke();
    }
    ctx.restore();

    // 临时绘制中的元素
    if (this.drawing) {
      this.drawElement(this.drawing.el);
    }

    // 已提交元素
    for (const el of this.elements) {
      this.drawElement(el);
      if (this.selected.has(el.id)) {
        this.drawSelectionBox(el);
      }
    }

    // 更新状态栏
    this.statusBar.textContent = `工具: ${TOOL_LABEL[this.tool]} · 已选 ${this.selected.size} 个元素 · 共 ${this.elements.length} 个元素`;
  }

  drawElement(el) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = el.strokeWidth;
    ctx.strokeStyle = el.strokeColor;
    ctx.fillStyle = el.backgroundColor;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    switch (el.type) {
      case "rectangle": {
        ctx.beginPath();
        const radius = 4;
        const { x, y, width, height } = el;
        ctx.roundRect(x, y, width, height, radius);
        if (el.backgroundColor !== "transparent") ctx.fill();
        ctx.stroke();
        break;
      }
      case "ellipse": {
        ctx.beginPath();
        ctx.ellipse(el.x, el.y, el.width / 2, el.height / 2, 0, 0, Math.PI * 2);
        if (el.backgroundColor !== "transparent") ctx.fill();
        ctx.stroke();
        break;
      }
      case "diamond": {
        ctx.beginPath();
        ctx.moveTo(el.x, el.y - el.height / 2);
        ctx.lineTo(el.x + el.width / 2, el.y);
        ctx.lineTo(el.x, el.y + el.height / 2);
        ctx.lineTo(el.x - el.width / 2, el.y);
        ctx.closePath();
        if (el.backgroundColor !== "transparent") ctx.fill();
        ctx.stroke();
        break;
      }
      case "line":
      case "arrow": {
        const pts = el.points;
        ctx.beginPath();
        ctx.moveTo(el.x + pts[0][0], el.y + pts[0][1]);
        ctx.lineTo(el.x + pts[1][0], el.y + pts[1][1]);
        ctx.stroke();
        if (el.type === "arrow" && el.endArrowhead === "arrow") {
          const ex = el.x + pts[1][0], ey = el.y + pts[1][1];
          const sx = el.x + pts[0][0], sy = el.y + pts[0][1];
          drawArrow(ctx, sx, sy, ex, ey, el.strokeColor, el.strokeWidth);
        }
        break;
      }
      case "freedraw": {
        ctx.beginPath();
        const pts = el.points;
        for (let i = 0; i < pts.length; i++) {
          const px = el.x + pts[i][0], py = el.y + pts[i][1];
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        break;
      }
      case "text": {
        ctx.font = `${el.fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.fillStyle = el.strokeColor;
        ctx.textBaseline = "top";
        ctx.fillText(el.text, el.x, el.y);
        break;
      }
    }
    ctx.restore();
  }

  drawSelectionBox(el) {
    const ctx = this.ctx;
    const box = this.elementBBox(el);
    ctx.save();
    ctx.strokeStyle = "#10b981";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(box.x - 4, box.y - 4, box.w + 8, box.h + 8);
    // 8 个控制点
    const handles = [
      [box.x - 4, box.y - 4], [box.x + box.w / 2, box.y - 4], [box.x + box.w + 4, box.y - 4],
      [box.x - 4, box.y + box.h / 2], [box.x + box.w + 4, box.y + box.h / 2],
      [box.x - 4, box.y + box.h + 4], [box.x + box.w / 2, box.y + box.h + 4], [box.x + box.w + 4, box.y + box.h + 4],
    ];
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff";
    handles.forEach(([hx, hy]) => {
      ctx.fillRect(hx - 3, hy - 3, 6, 6);
      ctx.strokeRect(hx - 3, hy - 3, 6, 6);
    });
    ctx.restore();
  }

  // ── 导出 / 清理 ────────────────────────────────────────

  toExcalidrawJson() {
    // 清理 isDeleted 元素
    const elems = this.elements.filter(e => !e.isDeleted).map(el => ({
      ...el,
      seed: nextSeed(),
      versionNonce: nextSeed(),
      updated: nowMs(),
    }));
    const allStroke = [...new Set(elems.map(e => e.strokeColor))];
    const allBg = [...new Set(elems.map(e => e.backgroundColor).filter(Boolean))];
    return {
      type: "excalidraw",
      version: 2,
      source: "MyTemple Knowledge",
      elements: elems,
      appState: {
        gridSize: null,
        viewBackgroundColor: "#ffffff",
        currentItemStrokeColor: this.strokeColor,
        currentItemBackgroundColor: this.bgColor,
        currentItemFillStyle: "solid",
        currentItemStrokeWidth: this.strokeWidth,
        currentItemStrokeStyle: "solid",
        currentItemRoughness: 1,
        currentItemOpacity: 100,
        currentItemFontFamily: 1,
        currentItemFontSize: this.fontSize,
        currentItemTextAlign: "left",
        currentItemStartArrowhead: null,
        currentItemEndArrowhead: "arrow",
        scrollX: 0, scrollY: 0,
        zoom: { value: 1 },
        theme: "light",
      },
      files: {},
    };
  }

  save() {
    if (this.onSave) {
      const json = this.toExcalidrawJson();
      this.onSave(json);
    }
    this.destroy();
  }

  cancel() {
    if (this.onCancel) this.onCancel();
    this.destroy();
  }

  destroy() {
    document.removeEventListener("keydown", this._onKeydown);
    if (this._onDocClick) document.removeEventListener("mousedown", this._onDocClick, true);
    // 清理残留 inline textarea
    if (this._textEditor) { try { this._textEditor.remove(); } catch (_) {} this._textEditor = null; }
    if (this.el && this.el.parentElement) {
      this.el.parentElement.removeChild(this.el);
    }
  }
}

// ── 工具函数 ─────────────────────────────────────────────

function pointToLine(px, py, x1, y1, x2, y2) {
  const A = px - x1, B = py - y1, C = x2 - x1, D = y2 - y1;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = lenSq !== 0 ? dot / lenSq : -1;
  param = Math.max(0, Math.min(1, param));
  const xx = x1 + param * C, yy = y1 + param * D;
  const dx = px - xx, dy = py - yy;
  return Math.sqrt(dx * dx + dy * dy);
}

function drawArrow(ctx, x1, y1, x2, y2, color, width) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = 12;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ── 公开 API ─────────────────────────────────────────────

/**
 * 打开绘图编辑器。
 * @returns {Promise<object|null>} Excalidraw JSON or null if cancelled
 */
export function openDrawEditor(initialJson = null) {
  return new Promise((resolve) => {
    const editor = new DrawEditor();
    editor.onSave = (json) => resolve(json);
    editor.onCancel = () => resolve(null);
    editor.mount(document.body);
    // 如果有初始数据，加载进去
    if (initialJson && initialJson.elements && Array.isArray(initialJson.elements)) {
      editor.elements = initialJson.elements.filter(e => !e.isDeleted);
      if (editor.elements.length > 0) {
        editor.undoStack.push([...editor.elements]);
      }
      editor.strokeColor = initialJson.appState?.currentItemStrokeColor || "#000000";
      editor.bgColor = initialJson.appState?.currentItemBackgroundColor || "transparent";
      editor.strokeWidth = initialJson.appState?.currentItemStrokeWidth || 2;
      editor.fontSize = initialJson.appState?.currentItemFontSize || 20;
      editor.render();
    } else {
      editor.undoStack.push([]);
    }
  });
}
