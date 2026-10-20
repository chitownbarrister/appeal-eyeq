// Documents: the default property folder template and document types (one list,
// used for new firms and for existing firms the first time), and the small
// rules shared by the server and the browser: what a file previews as, the
// suggested file name, and the Windows path budget.

import type { Level } from "./domain.js";

export const DOC_STATUSES = ["draft", "final", "filed", "superseded"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];
export const DOC_STATUS_LABELS: Record<DocStatus, string> = { draft: "Draft", final: "Final", filed: "Filed", superseded: "Superseded" };

/** Full level folder names (Dillon, Oct 20). Older short names are renamed in place when the template is applied. */
export const DEFAULT_LEVEL_FOLDERS: Record<Level, string> = {
  assessor: "Assessor",
  bor: "Board of Review",
  ptab: "Property Tax Appeal Board",
  circuit: "Circuit Court",
};
export const LEGACY_LEVEL_FOLDERS: Record<Level, string[]> = {
  assessor: ["ASSR"],
  bor: ["BOR"],
  ptab: ["PTAB"],
  circuit: ["SPOB"],
};

export const DEADZONE_FOLDER = "Deadzone";

/** The property folder template: top folders in order, with the document types that belong in each. */
export interface DefaultFolder { key: string; name: string; kind: "folder" | "appeals"; types: { name: string; protected?: boolean }[] }
export const DEFAULT_TEMPLATE: DefaultFolder[] = [
  { key: "engagement", name: "Engagement Agreements", kind: "folder", types: [{ name: "CFA", protected: true }] },
  {
    key: "property", name: "Property Documents", kind: "folder",
    types: [{ name: "Appraisal" }, { name: "Blueprints" }, { name: "Settlement Statement" }, { name: "Tax Bill" }, { name: "Assessor Document" }, { name: "Photo" }],
  },
  { key: "correspondence", name: "Correspondence", kind: "folder", types: [{ name: "Email" }, { name: "Letter" }] },
  { key: "evaluation", name: "Evaluation Worksheets", kind: "folder", types: [{ name: "Data Download" }, { name: "Worksheet" }, { name: "Tax Projection" }] },
  { key: "appeals", name: "Appeals", kind: "appeals", types: [] },
  { key: "billing", name: "Billing", kind: "folder", types: [{ name: "Invoice", protected: true }, { name: "Refund", protected: true }] },
  { key: "misc", name: "Misc", kind: "folder", types: [{ name: "File Front" }, { name: "Client Intake Form" }] },
];
/** Types filed in one level's folder. */
export const DEFAULT_LEVEL_TYPES: Partial<Record<Level, { name: string; protected?: boolean }[]>> = {
  assessor: [{ name: "Photograph Affidavit" }, { name: "CCAO Authorization" }, { name: "CCAO Brief", protected: true }, { name: "CCAO Photograph" }],
  bor: [{ name: "CCBOR Authorization" }, { name: "CCBOR Brief", protected: true }],
};
/** Types that belong in every level's folder. */
export const DEFAULT_ANY_LEVEL_TYPES: { name: string; protected?: boolean }[] = [
  { name: "Supporting Documentation" },
  { name: "Decision Letter", protected: true },
];

// ---------------------------------------------------------------- previews
export type PreviewKind = "pdf" | "image" | "office" | "sheet" | "text" | "email" | "audio" | "video" | "none";

const EXT_KIND: Record<string, PreviewKind> = {
  pdf: "pdf",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", svg: "image", heic: "none", tif: "none", tiff: "none",
  // Dropbox renders these as PDF
  doc: "office", docx: "office", docm: "office", rtf: "office", odt: "office", ppt: "office", pptx: "office", pptm: "office", pps: "office", ppsx: "office", ppsm: "office", odp: "office",
  // Dropbox renders these as HTML
  xls: "sheet", xlsx: "sheet", xlsm: "sheet", csv: "sheet", ods: "sheet",
  txt: "text", md: "text", json: "text", xml: "text", log: "text",
  eml: "email",
  mp3: "audio", m4a: "audio", wav: "audio",
  mp4: "video", mov: "video", webm: "video",
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function previewKind(name: string): PreviewKind {
  return EXT_KIND[extensionOf(name)] ?? "none";
}

/** Which desktop app "Open in" names for a file. */
export function desktopAppFor(name: string): string {
  const ext = extensionOf(name);
  if (["doc", "docx", "docm", "rtf", "odt"].includes(ext)) return "Word";
  if (["xls", "xlsx", "xlsm", "csv", "ods"].includes(ext)) return "Excel";
  if (["ppt", "pptx", "pptm", "pps", "ppsx", "ppsm", "odp"].includes(ext)) return "PowerPoint";
  if (ext === "pdf") return "your PDF app";
  if (ext === "eml" || ext === "msg") return "Outlook";
  return "the desktop app";
}

// ---------------------------------------------------------------- naming
/** "05-17-302-010 – Appraisal (2024).pdf": PIN first, the address is already in the folder path. */
export function suggestedFileName(pin: string | null, typeName: string, year: number | null, currentName: string): string {
  const ext = extensionOf(currentName);
  const parts = [pin, typeName].filter(Boolean).join(" – ");
  const base = year ? `${parts} (${year})` : parts;
  return ext ? `${base}.${ext}` : base;
}

/**
 * Windows (where some staff may sync Dropbox) won't open files whose full local path passes
 * 260 characters. The Dropbox folder itself sits at something like
 * C:\Users\<name>\<Firm> Dropbox\, so Appeal EyeQ keeps the Dropbox path under this budget.
 */
export const WINDOWS_PATH_BUDGET = 200;
export function pathTooLongForWindows(dropboxPath: string): boolean {
  return dropboxPath.length > WINDOWS_PATH_BUDGET;
}
