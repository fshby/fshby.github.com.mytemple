// 纸张纹理生成器：Perlin/Value 噪声 + Canvas 像素填充。
// 从 app.js 抽取，不依赖任何 app 模块级状态（DOM/els/state 均不触碰）。
// _paperBgCache / _paperBgCacheKey 仅由 getPaperBackgroundUrl 使用，故随函数一同迁移至此。

export function createPeriodicPerlin(gridSize, tileSize, seed) {
  const N = gridSize;
  const hashLen = N * N;
  const perm = new Int32Array(hashLen * 2);
  const gradX = new Float32Array(hashLen);
  const gradY = new Float32Array(hashLen);
  let s = seed | 0;
  function lcg() {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  }
  for (let i = 0; i < hashLen; i += 1) {
    perm[i] = i;
  }
  for (let i = hashLen - 1; i > 0; i -= 1) {
    const j = Math.floor(lcg() * (i + 1));
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  for (let i = 0; i < hashLen; i += 1) {
    const angle = lcg() * Math.PI * 2;
    gradX[i] = Math.cos(angle);
    gradY[i] = Math.sin(angle);
  }
  const t = 1 / tileSize;
  function fade(x) { return x * x * x * (x * (x * 6 - 15) + 10); }
  function lerp(a, b, t2) { return a + (b - a) * t2; }
  function noise(px, py) {
    const fx = px * t * N;
    const fy = py * t * N;
    const x0 = ((fx | 0) % N + N) % N;
    const y0 = ((fy | 0) % N + N) % N;
    const x1 = (x0 + 1) % N;
    const y1 = (y0 + 1) % N;
    const u = fade(fx - (fx | 0));
    const v = fade(fy - (fy | 0));
    const dx = fx - (fx | 0);
    const dy = fy - (fy | 0);
    const i00 = perm[y0 * N + x0];
    const i10 = perm[y0 * N + x1];
    const i01 = perm[y1 * N + x0];
    const i11 = perm[y1 * N + x1];
    const n00 = gradX[i00] * dx + gradY[i00] * dy;
    const n10 = gradX[i10] * (dx - 1) + gradY[i10] * dy;
    const n01 = gradX[i01] * dx + gradY[i01] * (dy - 1);
    const n11 = gradX[i11] * (dx - 1) + gradY[i11] * (dy - 1);
    const nx0 = lerp(n00, n10, u);
    const nx1 = lerp(n01, n11, u);
    return lerp(nx0, nx1, v);
  }
  // 多八度分形布朗运动 (fBm)
  function fbm(px, py, octaves) {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxValue = 0;
    for (let i = 0; i < octaves; i += 1) {
      value += noise(px * frequency, py * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }
    return value / maxValue;
  }
  return { noise, fbm };
}

// === 生成无缝平铺纸张纹理 ===
export function generateSeamlessPaperTextureDataUrl(size, seed) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const { fbm, noise } = createPeriodicPerlin(12, size, seed);

  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;

  const baseR = 238, baseG = 226, baseB = 200;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      const n1 = fbm(x * 0.8, y * 0.8, 4);
      const n2 = fbm(x * 2.5, y * 2.5, 3);
      const n3 = fbm(x * 5.0, y * 5.0, 2);

      const fiber = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;
      const intensity = (fiber + 1) * 0.5;

      const shade = 0.88 + intensity * 0.18;
      const tintR = 1.0;
      const tintG = 0.96 + intensity * 0.03;
      const tintB = 0.86 + intensity * 0.05;

      let r = baseR * shade * tintR;
      let g = baseG * shade * tintG;
      let b = baseB * shade * tintB;

      const ghash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const grain = (ghash - Math.floor(ghash)) - 0.5;
      const grainN = grain * 1.8;
      r += grainN;
      g += grainN * 0.5;
      b += grainN * 0.10;

      data[idx] = Math.max(0, Math.min(255, r));
      data[idx + 1] = Math.max(0, Math.min(255, g));
      data[idx + 2] = Math.max(0, Math.min(255, b));
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/png");
}

function _mkValueNoise2D(seed) {
  const SIZE = 256;
  const grid = new Float32Array(SIZE * SIZE);
  let s = seed | 0;
  function lcg() {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  }
  for (let i = 0; i < grid.length; i++) {
    grid[i] = lcg() * 2 - 1;
  }
  function smoothstep(t) { return t * t * (3 - 2 * t); }
  function noise(x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const xf = x - x0;
    const yf = y - y0;
    const x0m = ((x0 % SIZE) + SIZE) % SIZE;
    const x1m = ((x0 + 1) % SIZE + SIZE) % SIZE;
    const y0m = ((y0 % SIZE) + SIZE) % SIZE;
    const y1m = ((y0 + 1) % SIZE + SIZE) % SIZE;
    const v00 = grid[y0m * SIZE + x0m];
    const v10 = grid[y0m * SIZE + x1m];
    const v01 = grid[y1m * SIZE + x0m];
    const v11 = grid[y1m * SIZE + x1m];
    const u = smoothstep(xf);
    const v = smoothstep(yf);
    const nx0 = v00 + (v10 - v00) * u;
    const nx1 = v01 + (v11 - v01) * u;
    return nx0 + (nx1 - nx0) * v;
  }
  function fbm(x, y, octaves) {
    let val = 0, amp = 1, freq = 1, maxV = 0;
    for (let i = 0; i < octaves; i++) {
      val += noise(x * freq, y * freq) * amp;
      maxV += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return val / maxV;
  }
  return { noise, fbm };
}

export function generateLargePaperTextureDataUrl(w, h, seed) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const baseR = 238, baseG = 226, baseB = 200;

  const n1 = _mkValueNoise2D(seed);
  const n2 = _mkValueNoise2D(seed + 101);
  const n3 = _mkValueNoise2D(seed + 203);
  const n4 = _mkValueNoise2D(seed + 307);

  const imgData = ctx.createImageData(w, h);
  const data = imgData.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;

      const nx = x * 0.0025;
      const ny = y * 0.0025;
      const coarse = n1.fbm(nx, ny, 4);
      const medium = n2.fbm(x * 0.007, y * 0.007, 3);
      const fine = n3.fbm(x * 0.020, y * 0.020, 3);
      const micro = n4.fbm(x * 0.050, y * 0.050, 2);

      const combined = coarse * 0.48 + medium * 0.28 + fine * 0.16 + micro * 0.08;
      const intensity = (combined + 1) * 0.5;

      const shade = 0.88 + intensity * 0.20;
      const tintR = 1.0;
      const tintG = 0.96 + intensity * 0.03;
      const tintB = 0.86 + intensity * 0.05;

      let r = baseR * shade * tintR;
      let g = baseG * shade * tintG;
      let b = baseB * shade * tintB;

      const ghash = ((x * 374761393) ^ (y * 668265263)) & 0xff;
      const grainN = (ghash / 255 - 0.5) * 1.8;

      data[idx] = Math.max(0, Math.min(255, r + grainN));
      data[idx + 1] = Math.max(0, Math.min(255, g + grainN * 0.5));
      data[idx + 2] = Math.max(0, Math.min(255, b + grainN * 0.10));
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/png");
}

let _paperBgCache = "";
let _paperBgCacheKey = "";
export function getPaperBackgroundUrl() {
  const vw = window.innerWidth || 1920;
  const vh = window.innerHeight || 1080;
  const w = Math.min(vw, 2400);
  const h = Math.min(vh + 200, 2400);
  const key = `${w}x${h}`;
  if (_paperBgCacheKey === key && _paperBgCache) return _paperBgCache;
  try {
    _paperBgCache = generateLargePaperTextureDataUrl(w, h, 54321);
    _paperBgCacheKey = key;
    return _paperBgCache;
  } catch (_) {
    return "";
  }
}
