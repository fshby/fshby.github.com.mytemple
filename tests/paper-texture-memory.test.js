// 回归测试：纸张背景纹理的内存优化（大图 → 无缝 tile 平铺）
//
// 背景：护眼主题的背景原本按「视口尺寸」逐像素生成一张最大 2400×2400 的位图：
//   · 生成时 ImageData 峰值约 23MB（2400×2400×4）
//   · toDataURL 字符串数 MB，永久缓存在模块级变量里
//   · GPU 侧再解码成同尺寸纹理
//   · 视口一变（窗口缩放）就整张重生成
// 现改为 512×512 无缝 tile + background-repeat，内存降两个数量级。
// 本测试锁住「必须走 tile 路径」与其关键约束，防止回退。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const texSrc = readFileSync(new URL("../public/modules/paper-texture.js", import.meta.url), "utf8");
const appSrc = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

// 文件内顺序：createPeriodicPerlin → generateSeamless… → generateLarge… →
//               generatePaperBgTileDataUrl → getPaperBackgroundUrl（末尾）
const idxTile = texSrc.indexOf("export function generatePaperBgTileDataUrl");
const idxGetBg = texSrc.indexOf("export function getPaperBackgroundUrl");
assert.ok(idxTile > 0 && idxGetBg > idxTile, "定位失败：函数顺序与预期不符");
const tileBody = texSrc.slice(idxTile, idxGetBg);
const getBgBody = texSrc.slice(idxGetBg);

test("纸张背景默认走无缝 tile，不再按视口生成大图", () => {
  assert.match(getBgBody, /generatePaperBgTileDataUrl\(/, "默认路径必须生成 tile");
  assert.match(getBgBody, /PAPER_TILE_SIZE/, "tile 尺寸应为常量而非视口尺寸");
  // 大图函数只允许出现在 ?size= 探测分支里（便于现场对比排查）
  const largeCalls = getBgBody.match(/generateLargePaperTextureDataUrl\(/g) || [];
  assert.equal(largeCalls.length, 1, "大图生成只应保留 ?size= 探测这一处");
  assert.match(getBgBody, /URLSearchParams\(window\.location\.search\)\.get\("size"\)/, "探测开关需按 ?size= 判定");
});

test("背景 tile 缓存键与视口解耦（窗口缩放不再重生成）", () => {
  assert.match(getBgBody, /const key = `tile-\$\{PAPER_TILE_SIZE\}`/, "缓存键必须只由 tile 尺寸决定");
  // 旧实现把 innerWidth/innerHeight 编进 key，缩放窗口即重生成
  const afterKey = getBgBody.slice(getBgBody.indexOf("const key = `tile-"));
  assert.doesNotMatch(afterKey, /innerWidth|innerHeight/, "tile 路径不得再依赖视口尺寸");
});

test("tile 用多尺度周期噪声，复现旧大图的云状层次且四边无缝", () => {
  // 周期网格 3/6/24 分别对应粗/中/细尺度；必须全部走 createPeriodicPerlin（周期函数才无缝）
  assert.match(tileBody, /createPeriodicPerlin\(3, size, seed\)/, "粗尺度层");
  assert.match(tileBody, /createPeriodicPerlin\(6, size, seed \+ 101\)/, "中尺度层");
  assert.match(tileBody, /createPeriodicPerlin\(24, size, seed \+ 203\)/, "细尺度层");
  assert.equal(
    (tileBody.match(/createPeriodicPerlin\(/g) || []).length,
    3,
    "三层都必须是周期 Perlin，否则平铺会出现可见接缝",
  );
  // 层权重沿用旧大图，观感一致
  assert.match(tileBody, /nCoarse \* 0\.48/, "粗层权重 0.48");
  assert.match(tileBody, /nMedium \* 0\.28/, "中层权重 0.28");
  assert.match(tileBody, /nFine \* 0\.16/, "细层权重 0.16");
  // 色调映射与旧版一致（基础色 + shade 0.88~1.08 + 颗粒）
  assert.match(tileBody, /const baseR = 238, baseG = 226, baseB = 200/, "基础纸色需与旧版一致");
  assert.match(tileBody, /0\.88 \+ intensity \* 0\.20/, "明暗范围需与旧版一致");
  assert.match(tileBody, /374761393/, "微颗粒哈希需与旧版一致");
});

test("app.js 使用 tile 平铺的 background-size/repeat，且保留 CSS 变量可覆盖", () => {
  assert.match(appSrc, /--paper-bg-size:/, "tile 尺寸须通过 CSS 变量下发");
  assert.match(appSrc, /--paper-bg-repeat:/, "平铺方式须通过 CSS 变量下发");
  assert.match(appSrc, /background-size: var\(--paper-bg-size\), cover/, "首层背景用变量，其余装饰层保持 cover");
  assert.match(appSrc, /background-repeat: var\(--paper-bg-repeat\), no-repeat/, "首层重复方式用变量");
  assert.match(appSrc, /tileMode \? "repeat" : "no-repeat"/, "?size= 探测时退回不重复");
  assert.match(appSrc, /tileMode \? `\$\{PAPER_TILE_CSS_SIZE\}px \$\{PAPER_TILE_CSS_SIZE\}px` : "100% 100%"/, "1:1 像素尺寸，颗粒粗细与旧版一致");
});

test("panel 底纹不再生成（全项目无消费者，纯浪费）", () => {
  const body = appSrc.slice(appSrc.indexOf("function applyPaperTexture()"), appSrc.indexOf("styleEl.dataset.ready"));
  assert.doesNotMatch(body, /generateSeamlessPaperTextureDataUrl\(/, "已无消费者的面板纹理不得再生成");
  assert.match(body, /const panelVal = "none"/, "--paper-panel 保留变量但不再生成纹理");
  // app.js 不应再导入已不使用的纹理生成函数
  const importLine = appSrc.slice(appSrc.indexOf("paper-texture.js") - 120, appSrc.indexOf("paper-texture.js") + 30);
  assert.doesNotMatch(importLine, /generateSeamlessPaperTextureDataUrl/, "未使用的导入应清理");
});
