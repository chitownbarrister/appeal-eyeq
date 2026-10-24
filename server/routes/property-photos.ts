// A property's photo: shown (large or thumbnail), uploaded, removed. Mounted under /api/firm after
// requireFirmContext; everything runs inside withContext (row-level security) and filters on firm_id.
// Picking a photo from the property's Dropbox folder lives with the Files routes.

import express, { Router } from "express";
import { withContext } from "../db.js";
import { requirePermission } from "../auth.js";
import { httpError, idParam } from "./files-common.js";
import { MAX_PHOTO_BYTES, processPhoto, removePhoto, savePhoto } from "../photos.js";
import { safeName } from "../dropbox/folders.js";

export const propertyPhotosRouter = Router();

function pid(req: express.Request): number {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid property.");
  return id;
}

propertyPhotosRouter.get("/properties/:id/photo", async (req, res) => {
  const id = pid(req);
  const size = req.query.size === "large" ? "large" : "thumb";
  const row = await withContext(req.ctx!, async (c) =>
    (await c.query<{ img: Buffer; updated_at: Date }>(`SELECT ${size} AS img, updated_at FROM property_photos WHERE firm_id = $1 AND property_id = $2`, [req.ctx!.firmId, id])).rows[0]);
  if (!row) throw httpError(404, "No photo yet.");
  const etag = `"${new Date(row.updated_at).getTime().toString(36)}-${size}"`;
  res.setHeader("ETag", etag);
  // The address carries the photo's version (?v=), so a changed photo is a new address and the old one can be kept.
  res.setHeader("Cache-Control", req.query.v ? "private, max-age=31536000, immutable" : "private, no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.headers["if-none-match"] === etag) { res.status(304).end(); return; }
  res.setHeader("Content-Type", "image/jpeg");
  res.end(row.img);
});

propertyPhotosRouter.post(
  "/properties/:id/photo",
  requirePermission("properties.edit"),
  express.raw({ type: "application/octet-stream", limit: MAX_PHOTO_BYTES }),
  async (req, res) => {
    const id = pid(req);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, "The file is empty.");
    const name = safeName(String(req.query.name ?? "")).slice(0, 200) || "Photo";
    const exists = await withContext(req.ctx!, async (c) => (await c.query(`SELECT 1 FROM properties WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id])).rowCount);
    if (!exists) throw httpError(404, "Property not found.");
    const processed = await processPhoto(req.body);
    const at = await withContext(req.ctx!, (c) => savePhoto(c, req.ctx!.firmId!, id, processed, "upload", name, req.auth!.user.id));
    res.status(201).json({ photo: { updatedAt: at, width: processed.width, height: processed.height, source: "upload", sourceName: name } });
  },
);

propertyPhotosRouter.delete("/properties/:id/photo", requirePermission("properties.edit"), async (req, res) => {
  const id = pid(req);
  const gone = await withContext(req.ctx!, (c) => removePhoto(c, req.ctx!.firmId!, id, req.auth!.user.id));
  if (!gone) throw httpError(404, "No photo to remove.");
  res.json({ ok: true });
});
