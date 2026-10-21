// Reads an uploaded decision file's pages in a child process (ocr-worker), one
// file at a time across the whole server, so OCR never competes with itself for memory.

import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DecisionContentType = "application/pdf" | "image/png" | "image/jpeg";
export interface PageText { text: string; source: "text" | "ocr"; confidence: number | null }

/** The file's real type from its first bytes (the name and browser's claim aren't trusted). */
export function sniffType(buf: Buffer): DecisionContentType | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return null;
}

const IDLE_LIMIT_MS = Number(process.env.OCR_PAGE_TIMEOUT_MS) || 120_000; // the longest one page may take
let chain: Promise<unknown> = Promise.resolve();

function workerEntry(): { file: string; execArgv: string[] } {
  const here = fileURLToPath(import.meta.url);
  const heap = `--max-old-space-size=${Number(process.env.OCR_HEAP_MB) || 256}`;
  if (here.endsWith(".ts")) return { file: path.join(path.dirname(here), "ocr-worker.ts"), execArgv: ["--import", "tsx", heap] }; // tests run the source
  return { file: path.join(path.dirname(here), "ocr-worker.js"), execArgv: [heap] };
}

interface ChildMsg { type: string; count?: number; index?: number; text?: string; path?: string; confidence?: number | null; message?: string }

/** Runs one step of the worker, passing each message on; resolves when the step says it's done. */
function runStep(args: string[], onMessage: (m: ChildMsg) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const { file: entry, execArgv } = workerEntry();
    const child = fork(entry, args, { execArgv, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let settled = false;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
      if (process.env.OCR_REPORT_MEMORY) process.stderr.write(d);
    });
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      if (err) reject(err);
      else resolve();
    };
    const tooLong = () => finish(new Error("Reading the file took too long."));
    let timer = setTimeout(tooLong, IDLE_LIMIT_MS);
    child.on("message", (m: ChildMsg) => {
      clearTimeout(timer);
      timer = setTimeout(tooLong, IDLE_LIMIT_MS);
      if (m.type === "error") finish(new Error(m.message || "The file couldn't be read."));
      else if (m.type === "done") finish(null);
      else onMessage(m);
    });
    child.on("error", (err) => finish(err));
    child.on("exit", (code, signal) => {
      if (settled) return;
      const oom = /heap out of memory|Allocation failed/i.test(stderr) || signal === "SIGKILL";
      finish(new Error(oom ? "The file is too large to read in one go. Split it into smaller PDFs and upload them again." : `Reading stopped unexpectedly (${code ?? signal}).`));
    });
  });
}

/**
 * Step one draws the pages that need OCR into PNG files (and reads text layers); step two,
 * in a fresh process, OCRs those pictures. Each process exits before the next starts, so
 * pdf.js and Tesseract never hold memory at the same time.
 */
async function runWorker(file: Buffer, contentType: DecisionContentType, onProgress?: (read: number, total: number) => void): Promise<PageText[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aeq-decision-"));
  try {
    const tmp = path.join(dir, "upload");
    fs.writeFileSync(tmp, file);
    const pages: PageText[] = [];
    const images: { index: number; path: string }[] = [];
    let total = 0;
    const progress = () => onProgress?.(pages.filter(Boolean).length, total);
    await runStep(["render", tmp, contentType, dir], (m) => {
      if (m.type === "pages") total = m.count ?? 0;
      if (m.type === "text") { pages[m.index!] = { text: m.text ?? "", source: "text", confidence: null }; progress(); }
      if (m.type === "image") images.push({ index: m.index!, path: m.path! });
    });
    if (images.length) {
      const manifest = path.join(dir, "manifest.json");
      fs.writeFileSync(manifest, JSON.stringify(images));
      await runStep(["ocr", manifest], (m) => {
        if (m.type === "page") { pages[m.index!] = { text: m.text ?? "", source: "ocr", confidence: m.confidence ?? null }; progress(); }
      });
    }
    for (let i = 0; i < total; i++) pages[i] ??= { text: "", source: "ocr", confidence: null };
    return pages;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Every page's text, in order. Calls are queued so only one file is read at a time. */
export function readPages(file: Buffer, contentType: DecisionContentType, onProgress?: (read: number, total: number) => void): Promise<PageText[]> {
  const run = chain.then(() => runWorker(file, contentType, onProgress));
  chain = run.catch(() => undefined);
  return run;
}
