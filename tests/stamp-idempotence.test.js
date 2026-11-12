/* 回归锁：npm run stamp 必须幂等，且真实内容变化仍会改戳。
 *
 * 背景（2026-11-12）：app.js / guest.js 既参与指纹、又被脚本改写戳，形成自引用。
 * 修复前连跑 4 次得到 4 个不同戳（fc76f102→88d8404d→fc10a1a3→f0e3cb5e），
 * 脚本头注释「内容没变戳不变」不成立，每跑一次都产生无谓 diff。
 * 这里在临时沙箱里跑真实脚本（不碰仓库文件），锁住收敛性与敏感度。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts", "stamp.mjs");
const OLD = "20200101-00000000";
const TARGETS = ["public/index.html", "public/app.js", "public/guest.html", "public/guest.js"];

function sandbox() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mt-stamp-"));
  mkdirSync(path.join(tmp, "scripts"));
  mkdirSync(path.join(tmp, "public", "modules"), { recursive: true });
  copyFileSync(SCRIPT, path.join(tmp, "scripts", "stamp.mjs"));
  // 四个 restamp 目标 + 两个参与指纹的文件，初始都带一个「旧戳」
  writeFileSync(path.join(tmp, "public", "app.js"), `const U = "/styles.css?v=${OLD}";\n`);
  writeFileSync(path.join(tmp, "public", "styles.css"), `body{color:red} /* ?v=${OLD} */\n`);
  writeFileSync(path.join(tmp, "public", "guest.js"), `import "/editor-core.js?v=${OLD}";\n`);
  writeFileSync(path.join(tmp, "public", "guest.css"), "html{}\n");
  writeFileSync(path.join(tmp, "public", "index.html"),
    `<link href="/styles.css?v=${OLD}"><script src="/app.js?v=${OLD}"></script>\n`);
  writeFileSync(path.join(tmp, "public", "guest.html"),
    `<link href="/styles.css?v=${OLD}"><script src="/guest.js?v=${OLD}"></script>\n`);
  return tmp;
}

const run = (tmp) => execFileSync(process.execPath, [path.join(tmp, "scripts", "stamp.mjs")], {
  cwd: tmp, encoding: "utf8",
}).trim();
const read = (tmp, rel) => readFileSync(path.join(tmp, rel), "utf8");
const snapshot = (tmp) => TARGETS.map((f) => read(tmp, f));
const stampsIn = (text) => [...text.matchAll(/\?v=([0-9a-zA-Z._-]+)/g)].map((m) => m[1]);

test("stamp 幂等：内容不变时连跑三次，戳收敛且不再改写文件", () => {
  const tmp = sandbox();
  try {
    const first = run(tmp);
    assert.match(first, /缓存戳已更新为/, "首次应把旧戳换成新戳");
    const after = snapshot(tmp);
    const stamp = stampsIn(after[1])[0];
    assert.match(stamp, /^\d{8}-[0-9a-f]{8}$/, `戳形态异常：${stamp}`);
    // 四个目标里所有桌面戳必须统一（cloud-N 不在沙箱里）
    for (const text of after) {
      assert.deepEqual([...new Set(stampsIn(text))], [stamp], "四个目标的戳必须完全一致");
    }
    for (let i = 2; i <= 3; i++) {
      const out = run(tmp);
      assert.match(out, /缓存戳无需变更/, `第 ${i} 次运行不该再改戳`);
      assert.deepEqual(snapshot(tmp), after, `第 ${i} 次运行不得改写任何文件`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("真实内容变化时戳必须跟着变（归一化不能把内容变更也吃掉）", () => {
  const tmp = sandbox();
  try {
    run(tmp);
    const before = stampsIn(read(tmp, "public/app.js"))[0];
    writeFileSync(path.join(tmp, "public", "app.js"),
      `${read(tmp, "public/app.js")}\nconst FEATURE = "新增功能";\n`);
    const out = run(tmp);
    const after = stampsIn(read(tmp, "public/app.js"))[0];
    assert.match(out, /缓存戳已更新为/);
    assert.notEqual(after, before, "内容变了戳必须变，否则老用户会拿到缓存旧版");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cloud-N 人工云戳变更也会触发桌面端戳更新", () => {
  const tmp = sandbox();
  try {
    run(tmp);
    const before = stampsIn(read(tmp, "public/app.js"))[0];
    writeFileSync(path.join(tmp, "public", "app.js"),
      read(tmp, "public/app.js") + '\nimport "./m.js?v=cloud-24";\n');
    run(tmp);
    const mid = stampsIn(read(tmp, "public/app.js"));
    assert.ok(mid.includes("cloud-24"), "cloud-N 戳必须原样保留，不被桌面戳覆盖");
    writeFileSync(path.join(tmp, "public", "app.js"),
      read(tmp, "public/app.js").replace("cloud-24", "cloud-25"));
    run(tmp);
    const after = stampsIn(read(tmp, "public/app.js")).find((v) => /^\d{8}-/.test(v));
    assert.notEqual(after, before, "云戳变了，桌面端 app.js 内容也变了，戳必须跟着变");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
