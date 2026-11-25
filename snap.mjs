#!/usr/bin/env node
// Mermaid Snap CLI
// 同じフォルダの mermaid-snap.html を、PCに入っている Chrome / Edge で画面なしで開き、
// エディタと同じ見た目の SVG / PNG を書き出す。npm のインストールは不要。
//
// 使い方は `node snap.mjs --help` を参照。

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = join(HERE, "mermaid-snap.html");
const MERMAID = join(HERE, "mermaid.min.js");
const THEMES = ["default", "neutral", "forest", "base"];

const HELP = `Mermaid Snap CLI — Mermaid のコードを白背景の SVG / PNG にする

使い方:
  node snap.mjs <出力ファイル> [入力ファイル] [オプション]
  node snap.mjs --extract <図ファイル>

  出力ファイル   拡張子で形式が決まる（.svg / .png）
  入力ファイル   Mermaid のコード（.mmd / .md / .txt）。省略すると標準入力から読む
                 .md の中の \`\`\`mermaid ～ \`\`\` はそこだけを使う
                 このツールで作った .svg / .png を渡すと、中に埋め込んだコードを使う

オプション:
  --theme <名前>    default（既定） / neutral（白黒） / forest / base
  --scale <倍率>    PNG の画質。既定は 2
  --transparent     背景を透明にする（既定は白）
  --extract <図>    図に埋め込んだ Mermaid のコードを標準出力に出す
  --help            この説明を出す

書き出した図には、元の Mermaid のコードが埋め込まれる。
あとで直すときは --extract でコードを取り出し、直して同じ名前で書き出し直す。

例:
  node snap.mjs docs/images/構成図.svg 構成図.mmd
  node snap.mjs docs/images/構成図.png docs/images/構成図.svg --scale 3
  node snap.mjs --extract docs/images/構成図.svg

終了コード: 0 成功 / 1 Mermaid の書き間違い（内容は標準エラーに出る） / 2 その他のエラー

ブラウザの場所は自動で探す。見つからないときは環境変数 CHROME_PATH に chrome.exe か msedge.exe の場所を入れる。`;

function fail(msg, code = 2) {
  process.stderr.write(msg.replace(/\s*$/, "") + "\n");
  process.exit(code);
}

// ---- 引数 ----
const args = process.argv.slice(2);
const opt = { theme: "default", scale: 2, transparent: false };
const pos = [];
let extract = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--help" || a === "-h") { process.stdout.write(HELP + "\n"); process.exit(0); }
  else if (a === "--theme") opt.theme = args[++i];
  else if (a === "--scale") opt.scale = Number(args[++i]);
  else if (a === "--transparent") opt.transparent = true;
  else if (a === "--extract") extract = args[++i];
  else if (a.startsWith("--")) fail(`知らないオプションです: ${a}\n使い方は node snap.mjs --help`);
  else pos.push(a);
}

// ---- 図にコードを埋め込む / 取り出す ----
const SVG_TAG = "mermaid-snap-source";
const PNG_KEY = "mermaid-snap-source";

function svgEmbed(svg, code) {
  const cdata = "<![CDATA[" + code.split("]]>").join("]]]]><![CDATA[>") + "]]>";
  const meta = `<metadata id="${SVG_TAG}">${cdata}</metadata>`;
  return svg.replace(/(<svg\b[^>]*>)/, `$1${meta}`);
}
function svgExtract(svg) {
  const m = svg.match(new RegExp(`<metadata id="${SVG_TAG}">([\\s\\S]*?)</metadata>`));
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngEmbed(png, code) {
  // iTXt チャンク（UTF-8 のテキスト）を IHDR の直後に入れる
  const body = Buffer.concat([Buffer.from(PNG_KEY, "latin1"), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(code, "utf8")]);
  const type = Buffer.from("iTXt", "latin1");
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, body])));
  const ihdrEnd = 8 + 4 + 4 + png.readUInt32BE(8) + 4;
  return Buffer.concat([png.subarray(0, ihdrEnd), len, type, body, crc, png.subarray(ihdrEnd)]);
}
function pngExtract(png) {
  let p = 8;
  while (p + 8 <= png.length) {
    const len = png.readUInt32BE(p), type = png.toString("latin1", p + 4, p + 8);
    if (type === "iTXt") {
      const d = png.subarray(p + 8, p + 8 + len);
      const z = d.indexOf(0);
      if (d.toString("latin1", 0, z) === PNG_KEY) {
        let q = z + 3; // 区切り、圧縮フラグ、圧縮方式
        q = d.indexOf(0, q) + 1; // 言語タグ
        q = d.indexOf(0, q) + 1; // 翻訳キーワード
        return d.toString("utf8", q);
      }
    }
    if (type === "IEND") break;
    p += 12 + len;
  }
  return null;
}
function codeFromImage(file) {
  const ext = extname(file).toLowerCase();
  const buf = readFileSync(file);
  if (ext === ".svg") return svgExtract(buf.toString("utf8"));
  if (ext === ".png") return pngExtract(buf);
  return undefined; // 画像ではない
}

// ---- --extract ----
if (extract) {
  if (!existsSync(extract)) fail(`ファイルがありません: ${extract}`);
  const code = codeFromImage(extract);
  if (code === undefined) fail("--extract に渡せるのは .svg か .png です");
  if (code === null) fail("この図には Mermaid のコードが埋め込まれていません（このツール以外で作った図です）");
  process.stdout.write(code.endsWith("\n") ? code : code + "\n");
  process.exit(0);
}

// ---- 入力と出力 ----
if (pos.length < 1) fail("出力ファイルを指定してください。\n使い方は node snap.mjs --help");
if (pos.length > 2) fail("引数が多すぎます。ファイル名に空白があるときは \" \" で囲んでください。");
const outFile = resolve(pos[0]);
const fmt = extname(outFile).toLowerCase().slice(1);
if (fmt !== "svg" && fmt !== "png") fail("出力ファイルの拡張子は .svg か .png にしてください");
if (!THEMES.includes(opt.theme)) fail(`--theme は ${THEMES.join(" / ")} のどれかです`);
if (!(opt.scale > 0 && opt.scale <= 8)) fail("--scale は 0 より大きく 8 以下の数にしてください");

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}
let code;
if (pos[1]) {
  if (!existsSync(pos[1])) fail(`入力ファイルがありません: ${pos[1]}`);
  const fromImg = codeFromImage(pos[1]);
  if (fromImg === null) fail("この図には Mermaid のコードが埋め込まれていません");
  code = fromImg === undefined ? readFileSync(pos[1], "utf8") : fromImg;
} else {
  if (process.stdin.isTTY) fail("入力ファイルを指定するか、標準入力でコードを渡してください。\n使い方は node snap.mjs --help");
  code = readStdin();
}
code = code.replace(/^﻿/, "");
if (!code.trim()) fail("Mermaid のコードが空です");

// ---- ブラウザを探す ----
function findBrowser() {
  const env = process.env;
  const list = [env.CHROME_PATH];
  if (process.platform === "win32") {
    for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
      if (!base) continue;
      list.push(join(base, "Google", "Chrome", "Application", "chrome.exe"));
      list.push(join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    list.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    list.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge", "/opt/pw-browsers/chromium/chrome-linux64/chrome");
  }
  return list.find((p) => p && existsSync(p));
}

if (!existsSync(HTML)) fail(`mermaid-snap.html が見つかりません。snap.mjs と同じフォルダに置いてください: ${HERE}`);
if (!existsSync(MERMAID)) fail(`mermaid.min.js が見つかりません。snap.mjs と同じフォルダに置いてください: ${HERE}`);
const browser = findBrowser();
if (!browser) fail("Chrome か Edge が見つかりません。環境変数 CHROME_PATH に chrome.exe か msedge.exe の場所を入れてください。");

// ---- 描画 ----
const work = mkdtempSync(join(tmpdir(), "mermaid-snap-"));
const cleanup = () => { try { rmSync(work, { recursive: true, force: true }); } catch {} };
const jobFile = join(work, "job.js");
const job = { code, theme: opt.theme, scale: opt.scale, transparent: opt.transparent, png: fmt === "png" };
writeFileSync(jobFile, "window.__snapJob(" + JSON.stringify(job).replace(/[\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16)) + ");", "utf8");

const url = pathToFileURL(HTML).href + "#job=" + encodeURIComponent(pathToFileURL(jobFile).href);
const flags = [
  "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--allow-file-access-from-files", `--user-data-dir=${join(work, "profile")}`,
  "--virtual-time-budget=30000", "--dump-dom", url,
];
if (process.platform === "linux" && process.getuid && process.getuid() === 0) flags.unshift("--no-sandbox");

const dom = await new Promise((res) => {
  const p = spawn(browser, flags, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let outText = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => (outText += d));
  p.stderr.resume();
  const timer = setTimeout(() => p.kill(), 90000);
  p.on("error", (e) => { clearTimeout(timer); res({ error: e.message }); });
  p.on("close", () => { clearTimeout(timer); res({ text: outText }); });
});
cleanup();

if (dom.error) fail(`ブラウザを起動できませんでした（${browser}）: ${dom.error}`);
const m = dom.text.match(/<pre id="snap-result"[^>]*>([A-Za-z0-9+/=\s]*)<\/pre>/);
if (!m || !m[1].trim()) fail(`図の書き出しが時間内に終わりませんでした（ブラウザ: ${browser}）`);
const result = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
if (!result.ok) fail("Mermaid の書き間違いがあります:\n" + result.error, 1);

mkdirSync(dirname(outFile), { recursive: true });
if (fmt === "svg") {
  writeFileSync(outFile, svgEmbed(result.svg, result.code), "utf8");
} else {
  const png = Buffer.from(result.png.split(",")[1], "base64");
  writeFileSync(outFile, pngEmbed(png, result.code));
}
process.stdout.write(`書き出しました: ${outFile}\n`);
