// Property photos: an uploaded (or Dropbox-picked) picture read (phone photos come out upright) and saved in two
// sizes: a large one for the property's header (up to 1600 px wide) and a square thumbnail for
// avatars (320 px, cropped to the middle). The original isn't kept. The sample firm's properties
// get stock photos from db/seed/sample/photos.
// Every function runs inside the caller's withContext and filters on firm_id.

import { createCanvas, loadImage } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";

export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const LARGE_WIDTH = 1600;
const THUMB = 320;

export type PhotoSource = "upload" | "dropbox" | "sample";
export interface ProcessedPhoto { large: Buffer; thumb: Buffer; width: number; height: number }

const fail = (status: number, publicMessage: string) => Object.assign(new Error(publicMessage), { status, publicMessage });

/** What kind of image the bytes are, by their first bytes (never the name or the stated type). */
export function sniffImage(b: Buffer): "jpeg" | "png" | "webp" | "heic" | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.length > 12 && b.toString("latin1", 4, 8) === "ftyp" && /^(heic|heix|hevc|mif1|msf1)$/.test(b.toString("latin1", 8, 12))) return "heic";
  return null;
}

/** Reads the image and makes the two sizes. Throws a plain-language 4xx when it can't. */
export async function processPhoto(bytes: Buffer, opts: { keepJpegIfFits?: boolean } = {}): Promise<ProcessedPhoto> {
  if (!bytes.length) throw fail(400, "The file is empty.");
  if (bytes.length > MAX_PHOTO_BYTES) throw fail(413, "A photo can be up to 15 MB.");
  const kind = sniffImage(bytes);
  if (kind === "heic") throw fail(415, "iPhone HEIC photos can't be read here yet. Export the photo as JPEG (or set the camera to Most Compatible) and upload that.");
  if (!kind) throw fail(415, "Use a JPEG, PNG or WebP photo.");
  let img: Awaited<ReturnType<typeof loadImage>>;
  try {
    img = await loadImage(bytes);
  } catch {
    throw fail(415, "That photo couldn't be read. Save it again as JPEG and try once more.");
  }
  // The image reader already turns a phone photo upright from its EXIF orientation.
  const srcW = img.width;
  const srcH = img.height;
  if (srcW < 200 || srcH < 150) throw fail(400, "That photo is too small. Use one at least 800 pixels wide.");

  // Drawn once on white (so a transparent PNG isn't black), and both sizes come from that.
  const up = createCanvas(srcW, srcH);
  const u = up.getContext("2d");
  u.fillStyle = "#ffffff";
  u.fillRect(0, 0, srcW, srcH);
  u.drawImage(img, 0, 0);

  const thumbOf = async () => {
    const side = Math.min(srcW, srcH);
    const thumb = createCanvas(THUMB, THUMB);
    const t = thumb.getContext("2d");
    t.imageSmoothingQuality = "high";
    t.drawImage(up, (srcW - side) / 2, (srcH - side) / 2, side, side, 0, 0, THUMB, THUMB);
    return thumb.encode("jpeg", 80);
  };
  // The sample's own files are already the large size, so they're kept as they are.
  if (opts.keepJpegIfFits && kind === "jpeg" && srcW <= LARGE_WIDTH) return { large: bytes, thumb: await thumbOf(), width: srcW, height: srcH };

  const w = Math.min(LARGE_WIDTH, srcW);
  const h = Math.round((srcH * w) / srcW);
  const large = createCanvas(w, h);
  const l = large.getContext("2d");
  l.imageSmoothingQuality = "high";
  l.drawImage(up, 0, 0, w, h);

  return { large: await large.encode("jpeg", 82), thumb: await thumbOf(), width: w, height: h };
}

/** Saves (or replaces) the property's photo, with a small audit row (the image itself isn't audited). */
export async function savePhoto(
  c: pg.PoolClient, firmId: number, propertyId: number, p: ProcessedPhoto, source: PhotoSource, sourceName: string | null, userId: number | null, actorKind = "firm_user",
): Promise<string> {
  const before = (await c.query(`SELECT source, source_name FROM property_photos WHERE firm_id = $1 AND property_id = $2`, [firmId, propertyId])).rows[0] ?? null;
  const row = (await c.query<{ updated_at: string }>(
    `INSERT INTO property_photos (firm_id, property_id, large, thumb, width, height, source, source_name, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (firm_id, property_id) DO UPDATE SET large = EXCLUDED.large, thumb = EXCLUDED.thumb, width = EXCLUDED.width, height = EXCLUDED.height,
       source = EXCLUDED.source, source_name = EXCLUDED.source_name, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING updated_at`,
    [firmId, propertyId, p.large, p.thumb, p.width, p.height, source, sourceName?.slice(0, 255) ?? null, userId],
  )).rows[0];
  await c.query(
    `INSERT INTO audit_log (firm_id, actor_user_id, actor_kind, table_name, row_id, action, before, after) VALUES ($1, $2, $3, 'property_photos', $4, $5, $6, $7)`,
    [firmId, userId, actorKind, String(propertyId), before ? "UPDATE" : "INSERT", before, { source, source_name: sourceName, width: p.width, height: p.height, large_bytes: p.large.length }],
  );
  return row.updated_at;
}

export async function removePhoto(c: pg.PoolClient, firmId: number, propertyId: number, userId: number): Promise<boolean> {
  const before = (await c.query(`DELETE FROM property_photos WHERE firm_id = $1 AND property_id = $2 RETURNING source, source_name`, [firmId, propertyId])).rows[0];
  if (before) {
    await c.query(
      `INSERT INTO audit_log (firm_id, actor_user_id, actor_kind, table_name, row_id, action, before, after) VALUES ($1, $2, 'firm_user', 'property_photos', $3, 'DELETE', $4, NULL)`,
      [firmId, userId, String(propertyId), before],
    );
  }
  return Boolean(before);
}

// ---------------------------------------------------------------- the sample firm's photos
const SAMPLE_DIR = path.resolve(process.cwd(), "db", "seed", "sample", "photos");
/** "1300 Sheridan Rd." is 1300-sheridan.jpg, "1180 N. Green Bay Rd." is 1180-n-green-bay.jpg. */
export function samplePhotoName(address: string): string {
  return address.toLowerCase().replace(/\./g, "").replace(/\b(road|rd|ave|avenue|st|street|blvd|dr)\b/g, "").trim().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
}

/** Gives each sample property its stock photo (only those that have none). Returns how many were added. */
export async function seedSamplePhotos(c: pg.PoolClient, firmId: number): Promise<number> {
  if (!fs.existsSync(SAMPLE_DIR)) return 0;
  const props = (await c.query<{ id: number; address1: string }>(
    `SELECT p.id, p.address1 FROM properties p WHERE p.firm_id = $1 AND NOT EXISTS (SELECT 1 FROM property_photos x WHERE x.firm_id = p.firm_id AND x.property_id = p.id)`,
    [firmId],
  )).rows;
  let n = 0;
  for (const p of props) {
    const file = path.join(SAMPLE_DIR, `${samplePhotoName(p.address1 ?? "")}.jpg`);
    if (!p.address1 || !fs.existsSync(file)) continue;
    const processed = await processPhoto(fs.readFileSync(file), { keepJpegIfFits: true });
    await savePhoto(c, firmId, p.id, processed, "sample", "Sample photo", null, "system");
    n++;
  }
  return n;
}
