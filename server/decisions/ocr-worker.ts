// Reads the pages of one uploaded file, in two short-lived child processes run one
// after the other (see read-file.ts), so the memory each step needs is handed back to
// the system before the next starts and never touches the web server:
//
//   render  A PDF page with a text layer (an e-filed PTAB decision, or a scan the scanner
//           already OCR'd) is read from that layer. A page with a picture on it, or a
//           photo upload, is drawn at 200 dpi and saved as a PNG for the next step.
//   ocr     Each saved picture is read with Tesseract (English, bundled with the app,
//           nothing downloaded). A page that reads badly is tried again turned a half,
//           a quarter and three quarters, since scans go through feeders sideways too.
//
// Usage: node ocr-worker.js render <file> <content type> <out dir>
//        node ocr-worker.js ocr <manifest.json>
// Messages to the parent: {type:"pages",count} {type:"text",index,text} {type:"image",index,path}
//                         {type:"page",index,text,confidence} {type:"done"} {type:"error",message}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { linesFromTextItems, type TextItem } from "./text-layer.js";

const DPI = Number(process.env.OCR_DPI) || 200;
const MAX_SIDE = 2600;           // pixels on the long side, for memory
const MIN_TEXT_LAYER_CHARS = 40; // letters and digits a page needs before its text layer is trusted
const RETRY_BELOW = 55;          // OCR confidence under which other orientations are tried

type Msg =
  | { type: "pages"; count: number }
  | { type: "text"; index: number; text: string }
  | { type: "image"; index: number; path: string }
  | { type: "page"; index: number; text: string; confidence: number }
  | { type: "done" }
  | { type: "error"; message: string };

// IPC sends are asynchronous; the process waits for every one to go out before it exits.
let outbox: Promise<void> = Promise.resolve();
function send(m: Msg): void {
  outbox = outbox.then(() => new Promise<void>((resolve) => {
    if (process.send) process.send(m, undefined, {}, () => resolve());
    else process.stdout.write(`${JSON.stringify(m)}\n`, () => resolve());
  }));
}

function whiteCanvas(width: number, height: number): Canvas {
  const c = createCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

// ---------------------------------------------------------------- render
async function render(file: Buffer, contentType: string, outDir: string): Promise<void> {
  const save = (c: Canvas, index: number) => {
    const p = path.join(outDir, `page-${index}.png`);
    fs.writeFileSync(p, c.toBuffer("image/png"));
    send({ type: "image", index, path: p });
  };
  if (contentType !== "application/pdf") {
    const img = await loadImage(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const c = whiteCanvas(img.width * scale, img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    send({ type: "pages", count: 1 });
    save(c, 0);
    return;
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(file), disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageXObjectRepeat]);
  send({ type: "pages", count: doc.numPages });
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const layer = linesFromTextItems((await page.getTextContent()).items as TextItem[]);
    // A page with a picture on it (a scan, perhaps under a typed caption) is read from the picture.
    const ops = await page.getOperatorList();
    const hasImage = ops.fnArray.some((fn: number) => imageOps.has(fn));
    if (!hasImage && (layer.match(/[A-Za-z0-9]/g) ?? []).length >= MIN_TEXT_LAYER_CHARS) {
      send({ type: "text", index: i - 1, text: layer });
      page.cleanup();
      continue;
    }
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(DPI / 72, MAX_SIDE / Math.max(base.width, base.height)) });
    const canvas = whiteCanvas(vp.width, vp.height);
    // pdf.js types expect a DOM canvas; @napi-rs/canvas implements the same 2D API.
    await page.render({ canvasContext: canvas.getContext("2d") as never, viewport: vp, canvas: canvas as never }).promise;
    page.cleanup();
    save(canvas, i - 1);
  }
  await task.destroy();
}

// ---------------------------------------------------------------- ocr
function rotated(src: Canvas, quarterTurns: number): Canvas {
  const swap = quarterTurns % 2 === 1;
  const c = createCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const ctx = c.getContext("2d");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((quarterTurns * Math.PI) / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

async function ocr(manifest: { index: number; path: string }[]): Promise<void> {
  const { createWorker } = await import("tesseract.js");
  const require = createRequire(import.meta.url);
  const langDir = path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
  const worker = await createWorker("eng", 1, { langPath: langDir, gzip: true, cachePath: path.join(os.tmpdir(), "appeal-eyeq-ocr") });
  await worker.setParameters({ preserve_interword_spaces: "1" });
  for (const m of manifest) {
    const png = fs.readFileSync(m.path);
    let best = await worker.recognize(png);
    if (best.data.confidence < RETRY_BELOW) {
      const img = await loadImage(png);
      const c = whiteCanvas(img.width, img.height);
      c.getContext("2d").drawImage(img, 0, 0);
      for (const turns of [2, 1, 3]) {
        const r = await worker.recognize(rotated(c, turns).toBuffer("image/png"));
        if (r.data.confidence > best.data.confidence) best = r;
        if (best.data.confidence >= RETRY_BELOW + 20) break;
      }
    }
    send({ type: "page", index: m.index, text: best.data.text, confidence: Math.round(best.data.confidence * 100) / 100 });
  }
  await worker.terminate();
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "render") await render(fs.readFileSync(args[0]), args[1], args[2]);
  else if (mode === "ocr") await ocr(JSON.parse(fs.readFileSync(args[0], "utf8")));
  else throw new Error("Unknown step.");
  if (process.env.OCR_REPORT_MEMORY) process.stderr.write(`peak ${mode} ${fs.readFileSync("/proc/self/status", "utf8").match(/VmHWM:\s*(\d+)/)?.[1]} kB\n`);
  send({ type: "done" });
}

main().then(
  async () => { await outbox; process.exit(0); },
  async (err) => {
    send({ type: "error", message: err instanceof Error ? err.message.slice(0, 300) : "The file couldn't be read." });
    await outbox;
    process.exit(1);
  },
);
