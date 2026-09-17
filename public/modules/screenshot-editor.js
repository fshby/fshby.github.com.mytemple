// screenshot-editor.js — 截图标注编辑器
// 对标微信截图：矩形框、箭头、画笔、文字、马赛克、序号标签
// 零依赖，100% 离线可用

const TOOLS = [
  { id: 'rectangle', label: '▭', title: '矩形框' },
  { id: 'arrow', label: '→', title: '箭头' },
  { id: 'brush', label: '✏', title: '画笔' },
  { id: 'text', label: 'T', title: '文字' },
  { id: 'mosaic', label: '▦', title: '马赛克' },
  { id: 'tag', label: '①', title: '序号标签' },
];
const COLORS = ['#ff3333', '#ffcc00', '#33ff66', '#33aaff', '#ffffff', '#000000'];
const WIDTHS = [2, 4, 8];
const TAG_COLORS = ['#e8462e', '#f5a623', '#4caf50', '#2196f3', '#9c27b0', '#00bcd4'];

/**
 * 创建截图标注编辑器
 * @param {HTMLElement} overlay - 截图遮罩层
 * @param {Image} bgImg - 全屏截图 Image 对象（已加载完成）
 * @param {{x:number,y:number,w:number,h:number}} region - 选区 CSS 坐标
 * @param {number} dpr - 设备像素比
 * @param {{onConfirm:Function,onCancel:Function,onOcr:Function}} callbacks
 * @returns {{destroy:Function, getCanvas:Function}}
 */
export function createScreenshotEditor(overlay, bgImg, region, dpr, callbacks) {
  let currentTool = 'rectangle';
  let currentColor = '#ff3333';
  let currentWidth = 4;
  let annotations = [];
  let redoStack = [];
  let isDrawing = false;
  let startPos = null;
  let curPos = null;
  let tagCounter = 0;
  let textInputEl = null;
  let mosaicCanvas = null;

  // 创建标注画布（覆盖整个屏幕，CSS 像素）
  const annoCanvas = document.createElement('canvas');
  annoCanvas.className = 'annotation-canvas';
  annoCanvas.width = window.innerWidth;
  annoCanvas.height = window.innerHeight;
  annoCanvas.style.cssText = 'position:absolute;inset:0;z-index:2;cursor:crosshair;';
  overlay.appendChild(annoCanvas);
  const ctx = annoCanvas.getContext('2d');

  // 预生成马赛克画布（从背景图降采样）
  function ensureMosaicCanvas() {
    if (mosaicCanvas) return mosaicCanvas;
    mosaicCanvas = document.createElement('canvas');
    mosaicCanvas.width = Math.max(1, Math.ceil(window.innerWidth / 12));
    mosaicCanvas.height = Math.max(1, Math.ceil(window.innerHeight / 12));
    const mctx = mosaicCanvas.getContext('2d');
    mctx.imageSmoothingEnabled = true;
    mctx.drawImage(bgImg, 0, 0, mosaicCanvas.width, mosaicCanvas.height);
    return mosaicCanvas;
  }

  // 创建工具栏
  const toolbar = document.createElement('div');
  toolbar.className = 'annotation-toolbar';
  toolbar.innerHTML = buildToolbarHTML();
  overlay.appendChild(toolbar);
  positionToolbar();

  // 隐藏旧的选区提示和工具栏
  const oldToolbar = overlay.querySelector('.capture-toolbar');
  if (oldToolbar) oldToolbar.style.display = 'none';
  const oldHint = overlay.querySelector('.capture-hint');
  if (oldHint) oldHint.style.display = 'none';

  function buildToolbarHTML() {
    const toolBtns = TOOLS.map(t =>
      `<button type="button" class="anno-tool${t.id === currentTool ? ' active' : ''}" data-tool="${t.id}" title="${t.title}">${t.label}</button>`
    ).join('');
    const colorBtns = COLORS.map(c =>
      `<button type="button" class="anno-color${c === currentColor ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>`
    ).join('');
    const widthBtns = WIDTHS.map(w =>
      `<button type="button" class="anno-width${w === currentWidth ? ' active' : ''}" data-width="${w}" title="${w}px"><span style="height:${w}px;width:14px;background:currentColor;border-radius:2px;display:block"></span></button>`
    ).join('');
    return `
      <div class="anno-tools">${toolBtns}</div>
      <div class="anno-divider"></div>
      <div class="anno-colors">${colorBtns}</div>
      <div class="anno-divider"></div>
      <div class="anno-widths">${widthBtns}</div>
      <div class="anno-divider"></div>
      <button type="button" class="anno-action anno-undo" title="撤销 (Ctrl+Z)" disabled>↶</button>
      <button type="button" class="anno-action anno-redo" title="重做 (Ctrl+Y)" disabled>↷</button>
      <div class="anno-divider"></div>
      <button type="button" class="anno-action anno-ocr" title="识别文字">OCR</button>
      <div class="anno-divider"></div>
      <button type="button" class="anno-action anno-confirm" title="确认 (Enter)">✓</button>
      <button type="button" class="anno-action anno-cancel" title="取消 (ESC)">✕</button>
    `;
  }

  function positionToolbar() {
    const btnW = toolbar.offsetWidth || 600;
    const btnH = toolbar.offsetHeight || 40;
    let left = region.x + region.w - btnW;
    let top = region.y + region.h + 6;
    if (top + btnH > window.innerHeight) top = region.y - btnH - 6;
    if (left < 4) left = 4;
    if (left + btnW > window.innerWidth) left = window.innerWidth - btnW - 4;
    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';
  }

  // 事件绑定
  toolbar.addEventListener('click', onToolbarClick);
  annoCanvas.addEventListener('mousedown', onCanvasDown);
  document.addEventListener('mousemove', onCanvasMove);
  document.addEventListener('mouseup', onCanvasUp);
  document.addEventListener('keydown', onKeyDown, true);

  let brushPath = null;

  function onToolbarClick(e) {
    const toolBtn = e.target.closest('[data-tool]');
    if (toolBtn) {
      currentTool = toolBtn.dataset.tool;
      toolbar.querySelectorAll('.anno-tool').forEach(b => b.classList.toggle('active', b.dataset.tool === currentTool));
      removeTextInput();
      return;
    }
    const colorBtn = e.target.closest('[data-color]');
    if (colorBtn) {
      currentColor = colorBtn.dataset.color;
      toolbar.querySelectorAll('.anno-color').forEach(b => b.classList.toggle('active', b === colorBtn));
      return;
    }
    const widthBtn = e.target.closest('[data-width]');
    if (widthBtn) {
      currentWidth = parseInt(widthBtn.dataset.width);
      toolbar.querySelectorAll('.anno-width').forEach(b => b.classList.toggle('active', b.dataset.width == currentWidth));
      return;
    }
    if (e.target.closest('.anno-undo')) { undo(); return; }
    if (e.target.closest('.anno-redo')) { redo(); return; }
    if (e.target.closest('.anno-ocr')) { doOCR(); return; }
    if (e.target.closest('.anno-confirm')) { confirmEdit('copy'); return; }
    if (e.target.closest('.anno-cancel')) { cancel(); return; }
  }

  function inRegion(x, y) {
    return x >= region.x && x <= region.x + region.w &&
           y >= region.y && y <= region.y + region.h;
  }

  function onCanvasDown(e) {
    if (e.button !== 0) return;
    const x = e.clientX, y = e.clientY;
    if (!inRegion(x, y)) return;
    e.preventDefault();
    removeTextInput();

    if (currentTool === 'text') {
      showTextInput(x, y);
      return;
    }
    if (currentTool === 'tag') {
      tagCounter++;
      const colorIdx = (tagCounter - 1) % TAG_COLORS.length;
      annotations.push({
        type: 'tag', x, y, num: tagCounter,
        color: TAG_COLORS[colorIdx], r: 16
      });
      redoStack = [];
      render();
      updateUndoRedo();
      return;
    }
    isDrawing = true;
    startPos = { x, y };
    curPos = { x, y };
    brushPath = null;

    if (currentTool === 'brush') {
      brushPath = { type: 'brush', points: [{ x, y }], color: currentColor, width: currentWidth };
      annotations.push(brushPath);
    }
  }

  function onCanvasMove(e) {
    if (!isDrawing) return;
    curPos = { x: e.clientX, y: e.clientY };

    if (currentTool === 'brush' && brushPath) {
      brushPath.points.push({ x: curPos.x, y: curPos.y });
    }
    render();
  }

  function onCanvasUp(e) {
    if (!isDrawing) return;
    isDrawing = false;
    const x1 = startPos.x, y1 = startPos.y;
    const x2 = curPos.x, y2 = curPos.y;

    if (currentTool === 'brush') {
      // 画笔路径在 move 中已收集，只需清理
      if (brushPath && brushPath.points.length < 2) {
        // 太短，移除
        annotations.pop();
      }
      brushPath = null;
    } else if (Math.abs(x2 - x1) < 3 && Math.abs(y2 - y1) < 3) {
      render();
      return;
    } else if (currentTool === 'rectangle') {
      annotations.push({
        type: 'rectangle',
        x: Math.min(x1, x2), y: Math.min(y1, y2),
        w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
        color: currentColor, width: currentWidth
      });
    } else if (currentTool === 'arrow') {
      annotations.push({
        type: 'arrow', x1, y1, x2, y2,
        color: currentColor, width: currentWidth
      });
    } else if (currentTool === 'mosaic') {
      annotations.push({
        type: 'mosaic', x1, y1, x2, y2,
        size: currentWidth * 3
      });
    }
    redoStack = [];
    render();
    updateUndoRedo();
  }

  function showTextInput(x, y) {
    removeTextInput();
    textInputEl = document.createElement('input');
    textInputEl.type = 'text';
    textInputEl.className = 'anno-text-input';
    textInputEl.style.cssText = `position:absolute;left:${x}px;top:${y - 12}px;z-index:3;
      background:rgba(255,255,255,0.95);border:2px solid ${currentColor};
      color:${currentColor};font-size:16px;padding:2px 6px;border-radius:2px;
      outline:none;min-width:60px;font-family:sans-serif;`;
    overlay.appendChild(textInputEl);
    textInputEl.focus();

    textInputEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = textInputEl.value.trim();
        if (text) {
          annotations.push({
            type: 'text', x, y, text,
            color: currentColor, size: 18
          });
          redoStack = [];
          render();
          updateUndoRedo();
        }
        removeTextInput();
      } else if (e.key === 'Escape') {
        removeTextInput();
      }
    });
    textInputEl.addEventListener('blur', () => {
      const text = textInputEl.value.trim();
      if (text) {
        annotations.push({
          type: 'text', x, y, text,
          color: currentColor, size: 18
        });
        redoStack = [];
        render();
        updateUndoRedo();
      }
      removeTextInput();
    });
  }

  function removeTextInput() {
    if (textInputEl && textInputEl.parentNode) {
      textInputEl.parentNode.removeChild(textInputEl);
    }
    textInputEl = null;
  }

  function onKeyDown(e) {
    if (textInputEl) return; // 文字输入时不拦截
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirmEdit('copy'); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); return; }
  }

  function undo() {
    if (annotations.length === 0) return;
    const item = annotations.pop();
    if (item.type === 'tag' && item.num === tagCounter) tagCounter--;
    redoStack.push(item);
    if (item === brushPath) brushPath = null;
    render();
    updateUndoRedo();
  }

  function redo() {
    if (redoStack.length === 0) return;
    const item = redoStack.pop();
    if (item.type === 'tag' && item.num > tagCounter) tagCounter = item.num;
    annotations.push(item);
    render();
    updateUndoRedo();
  }

  function updateUndoRedo() {
    const undoBtn = toolbar.querySelector('.anno-undo');
    const redoBtn = toolbar.querySelector('.anno-redo');
    if (undoBtn) undoBtn.disabled = annotations.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }

  async function doOCR() {
    if (callbacks.onOcr) {
      // 裁剪选区图片（含标注）发给 OCR 后端
      const cropCanvas = document.createElement('canvas');
      const sw = Math.round(region.w * dpr);
      const sh = Math.round(region.h * dpr);
      cropCanvas.width = sw; cropCanvas.height = sh;
      const cctx = cropCanvas.getContext('2d');
      const sx = Math.round(region.x * dpr);
      const sy = Math.round(region.y * dpr);
      // 先画背景
      cctx.drawImage(bgImg, sx, sy, sw, sh, 0, 0, sw, sh);
      // 再画标注
      cctx.drawImage(annoCanvas, region.x, region.y, region.w, region.h, 0, 0, sw, sh);
      const blob = await new Promise(res => cropCanvas.toBlob(res, 'image/png'));
      if (!blob) { showToast('截图裁剪失败'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        callbacks.onOcr(base64);
      };
      reader.readAsDataURL(blob);
    }
  }

  function confirmEdit(action) {
    removeTextInput();
    // 重定位工具栏位置
    cleanup();
    if (callbacks.onConfirm) {
      callbacks.onConfirm(action, annoCanvas);
    }
  }

  function cancel() {
    removeTextInput();
    cleanup();
    if (callbacks.onCancel) callbacks.onCancel();
  }

  function cleanup() {
    toolbar.removeEventListener('click', onToolbarClick);
    annoCanvas.removeEventListener('mousedown', onCanvasDown);
    document.removeEventListener('mousemove', onCanvasMove);
    document.removeEventListener('mouseup', onCanvasUp);
    document.removeEventListener('keydown', onKeyDown, true);
    if (toolbar.parentNode) toolbar.parentNode.removeChild(toolbar);
    if (annoCanvas.parentNode) annoCanvas.parentNode.removeChild(annoCanvas);
  }

  // ── 渲染 ──────────────────────────────
  function render() {
    ctx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);
    for (const a of annotations) {
      drawAnnotation(ctx, a);
    }
    // 实时预览
    if (isDrawing && startPos && curPos) {
      drawPreview(ctx);
    }
  }

  function drawPreview(ctx) {
    const x1 = startPos.x, y1 = startPos.y;
    const x2 = curPos.x, y2 = curPos.y;
    if (currentTool === 'rectangle') {
      drawRect(ctx, Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1), currentColor, currentWidth);
    } else if (currentTool === 'arrow') {
      drawArrow(ctx, x1, y1, x2, y2, currentColor, currentWidth);
    } else if (currentTool === 'mosaic') {
      drawMosaicRect(ctx, Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1), currentWidth * 3);
    }
  }

  function drawAnnotation(ctx, a) {
    switch (a.type) {
      case 'rectangle':
        drawRect(ctx, a.x, a.y, a.w, a.h, a.color, a.width);
        break;
      case 'arrow':
        drawArrow(ctx, a.x1, a.y1, a.x2, a.y2, a.color, a.width);
        break;
      case 'brush':
        drawBrush(ctx, a.points, a.color, a.width);
        break;
      case 'text':
        drawText(ctx, a.x, a.y, a.text, a.color, a.size);
        break;
      case 'mosaic':
        drawMosaicRect(ctx, Math.min(a.x1, a.x2), Math.min(a.y1, a.y2),
          Math.abs(a.x2 - a.x1), Math.abs(a.y2 - a.y1), a.size);
        break;
      case 'tag':
        drawTag(ctx, a.x, a.y, a.num, a.color, a.r);
        break;
    }
  }

  function drawRect(ctx, x, y, w, h, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash([]);
    ctx.strokeRect(x, y, w, h);
  }

  function drawArrow(ctx, x1, y1, x2, y2, color, width) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = Math.max(12, width * 4);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    // 箭头
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  function drawBrush(ctx, points, color, width) {
    if (!points || points.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }

  function drawText(ctx, x, y, text, color, size) {
    ctx.fillStyle = color;
    ctx.font = `${size}px sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y);
  }

  function drawTag(ctx, x, y, num, color, r) {
    // 外圆
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // 白色边框
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.stroke();
    // 数字
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(r * 1.1)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), x, y + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  function drawMosaicRect(ctx, x, y, w, h, blockSize) {
    if (w < 1 || h < 1) return;
    const mc = ensureMosaicCanvas();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    // 用最近邻放大马赛克画布
    ctx.imageSmoothingEnabled = false;
    // 计算马赛克画布的对应区域
    const sx = x / window.innerWidth * mc.width;
    const sy = y / window.innerHeight * mc.height;
    const sw = w / window.innerWidth * mc.width;
    const sh = h / window.innerHeight * mc.height;
    // 放大绘制（每个马赛克块 = blockSize x blockSize CSS像素）
    const blocksW = Math.ceil(w / blockSize);
    const blocksH = Math.ceil(h / blockSize);
    for (let bx = 0; bx < blocksW; bx++) {
      for (let by = 0; by < blocksH; by++) {
        const srcX = Math.floor(sx + bx * (sw / blocksW));
        const srcY = Math.floor(sy + by * (sh / blocksH));
        const srcW = Math.max(1, Math.ceil(sw / blocksW));
        const srcH = Math.max(1, Math.ceil(sh / blocksH));
        const dstX = x + bx * blockSize;
        const dstY = y + by * blockSize;
        ctx.drawImage(mc, srcX, srcY, srcW, srcH, dstX, dstY, blockSize, blockSize);
      }
    }
    ctx.imageSmoothingEnabled = true;
    ctx.restore();
  }

  // 初始渲染
  render();
  updateUndoRedo();

  return {
    destroy: cleanup,
    getCanvas: () => annoCanvas,
    getAnnotations: () => annotations,
  };
}
