#!/usr/bin/env node
// Mermaid Snap ワークベンチのサーバー
// リポジトリの .md にある ```mermaid ``` の図を 1 つずつページとして返し、
// 編集した図のコードと PNG を、その .md と images/ に書き戻す。npm のインストールは不要。
//
//   node serve.mjs [リポジトリのフォルダー] [--port 8765]
//   → http://127.0.0.1:8765/workbench.html

import { createServer } from "node:http";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, relative, basename, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let port = 8765, repoArg = null, openBrowser = false;
// リポジトリを指定しないときは、このフォルダーの隣を探す（clone したままの名前 kusakari-usecase も探す）
const NEIGHBORS = ["kusakari_document", "kusakari-usecase", "kusakari-document"];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") port = Number(args[++i]);
  else if (args[i] === "--open") openBrowser = true;
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`使い方: node serve.mjs [リポジトリのフォルダー] [--port 8765] [--open]\n  リポジトリを省くと、このフォルダーの隣の ${NEIGHBORS.join(" / ")} を使う\n  --open で、起動したあとブラウザーで開く`);
    process.exit(0);
  } else repoArg = args[i];
}
const REPO = repoArg ? resolve(repoArg) : (NEIGHBORS.map((n) => join(HERE, "..", n)).find((p) => existsSync(p)) || join(HERE, "..", NEIGHBORS[0]));
if (!existsSync(REPO) || !statSync(REPO).isDirectory()) {
  console.error(`リポジトリのフォルダーが見つかりません: ${REPO}`);
  console.error(`mermaid-snap と同じフォルダーに kusakari-usecase を clone するか、場所を指定してください（node serve.mjs <フォルダー>）`);
  process.exit(2);
}
const STATIC = { "/workbench.html": "text/html", "/mermaid-snap.html": "text/html", "/mermaid.min.js": "text/javascript" };
const SKIP_DIRS = new Set(["node_modules"]);

// ---- .md の読み書き ----
const sha = (buf) => createHash("sha1").update(buf).digest("hex");

function listMd(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) listMd(p, out);
    else if (extname(name).toLowerCase() === ".md") out.push(p);
  }
  return out;
}

function readMd(abs) {
  const buf = readFileSync(abs);
  let text = buf.toString("utf8");
  const bom = text.startsWith("﻿");
  if (bom) text = text.slice(1);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  return { hash: sha(buf), bom, eol, lines };
}

function writeMd(abs, md) {
  writeFileSync(abs, (md.bom ? "﻿" : "") + md.lines.join(md.eol), "utf8");
}

const IMG_RE = /^\s*!\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))\)\s*$/;

// ```mermaid の図を順に取り出す。start = 開きの行、end = 閉じの行（無ければ最後の行の次）
function blocks(lines) {
  const list = [];
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (h) { heading = h[1].trim(); continue; }
    const open = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*mermaid\b/i);
    if (!open) {
      const fence = lines[i].match(/^\s*(`{3,}|~{3,})/);
      if (fence) { // ほかの言語のコードブロックは飛ばす
        const close = new RegExp(`^\\s*${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},}\\s*$`);
        let j = i + 1;
        while (j < lines.length && !close.test(lines[j])) j++;
        i = j;
      }
      continue;
    }
    const indent = open[1], f = open[2];
    const close = new RegExp(`^\\s*${f[0] === "`" ? "`" : "~"}{${f.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j++;
    const code = lines.slice(i + 1, j).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n");
    // 閉じの後、空行を飛ばした最初の行が画像なら、それをこの図の PNG とする
    let img = null, k = j + 1;
    while (k < lines.length && !lines[k].trim()) k++;
    const m = k < lines.length && lines[k].match(IMG_RE);
    if (m) img = { line: k, alt: m[1], path: m[2] || m[3] };
    list.push({ start: i, end: j, indent, code, heading, img });
    i = j;
  }
  return list;
}

const toPosix = (p) => p.split(sep).join("/");

function resolveRel(rel) {
  const abs = resolve(REPO, rel);
  const r = relative(REPO, abs);
  if (!r || r.startsWith("..") || /^[a-z]:/i.test(r)) throw httpError(400, "リポジトリの外は扱えません");
  return abs;
}

function pngPathOf(mdAbs, b, index) {
  if (b.img && /\.png$/i.test(b.img.path) && !/^[a-z]+:/i.test(b.img.path)) return { abs: resolve(dirname(mdAbs), decodeURI(b.img.path)), linked: true };
  const name = `${basename(mdAbs, extname(mdAbs))}-${index + 1}.png`;
  return { abs: join(dirname(mdAbs), "images", name), linked: false, rel: `images/${name}` };
}

// ---- PNG に埋め込むコードと手直しの情報（iTXt） ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngEmbed(png, entries) {
  const chunks = Object.entries(entries).map(([key, text]) => {
    const body = Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(text, "utf8")]);
    const type = Buffer.from("iTXt", "latin1");
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, body])));
    return Buffer.concat([len, type, body, crc]);
  });
  const ihdrEnd = 8 + 4 + 4 + png.readUInt32BE(8) + 4;
  return Buffer.concat([png.subarray(0, ihdrEnd), ...chunks, png.subarray(ihdrEnd)]);
}
function pngTexts(png) {
  const out = {};
  if (png.length < 8 || png.toString("latin1", 1, 4) !== "PNG") return out;
  let p = 8;
  while (p + 8 <= png.length) {
    const len = png.readUInt32BE(p), type = png.toString("latin1", p + 4, p + 8);
    if (type === "iTXt") {
      const d = png.subarray(p + 8, p + 8 + len);
      const z = d.indexOf(0);
      let q = z + 3;
      q = d.indexOf(0, q) + 1;
      q = d.indexOf(0, q) + 1;
      out[d.toString("latin1", 0, z)] = d.toString("utf8", q);
    }
    if (type === "IEND") break;
    p += 12 + len;
  }
  return out;
}

// ---- API ----
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function branch() {
  try { return execFileSync("git", ["-C", REPO, "branch", "--show-current"], { encoding: "utf8" }).trim(); } catch (e) { return ""; }
}

function pageList() {
  const pages = [];
  for (const abs of listMd(REPO)) {
    const md = readMd(abs);
    const list = blocks(md.lines);
    list.forEach((b, i) => {
      const png = pngPathOf(abs, b, i);
      pages.push({
        id: `${toPosix(relative(REPO, abs))}#${i + 1}`,
        file: toPosix(relative(REPO, abs)), index: i + 1, count: list.length,
        heading: b.heading, hasPng: existsSync(png.abs), linked: png.linked
      });
    });
  }
  pages.sort((a, b) => (a.file === b.file ? a.index - b.index : a.file.localeCompare(b.file, "ja")));
  return { repo: REPO, branch: branch(), pages };
}

function parseId(id) {
  const m = String(id || "").match(/^(.+)#(\d+)$/);
  if (!m) throw httpError(400, "ページの ID が違います");
  return { file: m[1], index: Number(m[2]) };
}

function pageDetail(id) {
  const { file, index } = parseId(id);
  const abs = resolveRel(file);
  if (!existsSync(abs)) throw httpError(404, "ファイルがありません: " + file);
  const md = readMd(abs);
  const list = blocks(md.lines);
  const b = list[index - 1];
  if (!b) throw httpError(404, "図がありません: " + id);
  const png = pngPathOf(abs, b, index - 1);
  let layout = null, theme = null, pngCode = null;
  if (existsSync(png.abs)) {
    const t = pngTexts(readFileSync(png.abs));
    pngCode = t["mermaid-snap-source"] ?? null;
    try { const l = JSON.parse(t["mermaid-snap-layout"] || "null"); if (l) { layout = l.layout || null; theme = l.theme || null; } } catch (e) {}
  }
  return {
    id, file, index, count: list.length, heading: b.heading, hash: md.hash, code: b.code,
    png: toPosix(relative(REPO, png.abs)), hasPng: existsSync(png.abs), linked: png.linked,
    // PNG に入っているコードが今のコードと同じときだけ、手直しを戻せる
    layout: pngCode !== null && pngCode.trim() === b.code.trim() ? layout : null,
    theme, layoutStale: !!layout && pngCode !== null && pngCode.trim() !== b.code.trim()
  };
}

function save(body) {
  const { id, hash, code, png, theme, layout } = body || {};
  const { file, index } = parseId(id);
  if (typeof code !== "string" || typeof png !== "string" || !png.startsWith("data:image/png;base64,")) throw httpError(400, "保存する中身が足りません");
  const abs = resolveRel(file);
  const md = readMd(abs);
  if (md.hash !== hash) throw httpError(409, "開いた後に .md が変わっています。読み込み直してから保存してください");
  const list = blocks(md.lines);
  const b = list[index - 1];
  if (!b) throw httpError(404, "図がありません: " + id);
  const pngInfo = pngPathOf(abs, b, index - 1);
  resolveRel(relative(REPO, pngInfo.abs));

  const newCode = code.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  let changed = false;
  if (!pngInfo.linked) {
    // 画像の行が無ければ、閉じの行の後に足す
    const after = b.end + 1;
    const add = ["", `![${basename(abs, extname(abs))} の図 ${index}](<${pngInfo.rel}>)`];
    if (after < md.lines.length && md.lines[after].trim()) add.push("");
    md.lines.splice(after, 0, ...add);
    changed = true;
  }
  if (newCode !== b.code.replace(/\n+$/, "")) {
    md.lines.splice(b.start + 1, b.end - b.start - 1, ...newCode.split("\n").map((l) => (l ? b.indent + l : l)));
    changed = true;
  }
  const raw = Buffer.from(png.slice("data:image/png;base64,".length), "base64");
  if (raw.toString("latin1", 1, 4) !== "PNG") throw httpError(400, "PNG ではありません");
  const out = pngEmbed(raw, {
    "mermaid-snap-source": newCode + "\n",
    "mermaid-snap-layout": JSON.stringify({ theme: theme || "default", layout: layout || {} })
  });
  mkdirSync(dirname(pngInfo.abs), { recursive: true });
  writeFileSync(pngInfo.abs, out);
  if (changed) writeMd(abs, md);
  return { ok: true, mdChanged: changed, png: toPosix(relative(REPO, pngInfo.abs)), page: pageDetail(id) };
}

function readBody(req) {
  return new Promise((ok, ng) => {
    const parts = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 64 * 1024 * 1024) { ng(httpError(413, "大きすぎます")); req.destroy(); } else parts.push(c); });
    req.on("end", () => { try { ok(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); } catch (e) { ng(httpError(400, "JSON が読めません")); } });
    req.on("error", ng);
  });
}

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, "application/json; charset=utf-8", JSON.stringify(obj));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    // ほかのサイトからの書き込みを断る
    if (req.method !== "GET" && req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}` && req.headers.origin !== `http://localhost:${port}`) throw httpError(403, "このページ以外からは書き込めません");
    if (req.method === "GET" && (url.pathname === "/" || STATIC[url.pathname])) {
      const p = url.pathname === "/" ? "/workbench.html" : url.pathname;
      return send(res, 200, STATIC[p] + "; charset=utf-8", readFileSync(join(HERE, p.slice(1))));
    }
    if (req.method === "GET" && url.pathname === "/api/pages") return json(res, 200, pageList());
    if (req.method === "GET" && url.pathname === "/api/page") return json(res, 200, pageDetail(url.searchParams.get("id")));
    if (req.method === "GET" && url.pathname === "/api/png") {
      const abs = resolveRel(url.searchParams.get("path") || "");
      if (!/\.png$/i.test(abs) || !existsSync(abs)) throw httpError(404, "PNG がありません");
      return send(res, 200, "image/png", readFileSync(abs));
    }
    if (req.method === "POST" && url.pathname === "/api/save") return json(res, 200, save(await readBody(req)));
    throw httpError(404, "ありません");
  } catch (e) {
    json(res, e.status || 500, { ok: false, error: e.status ? e.message : "サーバーでエラーが起きました" });
    if (!e.status) console.error(e);
  }
});
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`ポート ${port} はほかのプログラムが使っています。すでにワークベンチが動いていないか確かめるか、--port 8766 のように別の番号で起動してください`);
  else console.error(e.message);
  process.exit(2);
});
server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/workbench.html`;
  console.log(`リポジトリ: ${REPO}`);
  console.log(`${url} を開いてください（止めるときは Ctrl+C か、この画面を閉じる）`);
  if (openBrowser) {
    const [cmd, cmdArgs] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
    spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
});
