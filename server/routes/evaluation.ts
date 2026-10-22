// The property's Evaluation tab and its Excel export. Mounted under /api/firm after
// requireFirmContext; everything runs inside withContext (row-level security) and filters on firm_id.

import { Router } from "express";
import { withContext } from "../db.js";
import { todayIso } from "../today.js";
import { buildEvaluation } from "../evaluation.js";
import { evaluationWorkbook } from "../evaluation-xlsx.js";
import { shortPin } from "../../shared/domain.js";
import { httpError, idParam } from "./files-common.js";

export const evaluationRouter = Router();

/** The three most recent assessment years (the tab), or every year (the full history). */
const pick = <T>(years: T[], all: boolean) => (all ? years : years.slice(-3));

evaluationRouter.get("/properties/:id/evaluation", async (req, res) => {
  const pid = idParam(req);
  if (!pid) throw httpError(400, "Invalid property.");
  const ev = await withContext(req.ctx!, (c) => buildEvaluation(c, req.ctx!.firmId!, pid, todayIso()));
  if (!ev) throw httpError(404, "Property not found.");
  res.json({ ...ev, recent: pick(ev.years, false).map((y) => y.assessmentYear) });
});

evaluationRouter.get("/properties/:id/evaluation.xlsx", async (req, res) => {
  const pid = idParam(req);
  if (!pid) throw httpError(400, "Invalid property.");
  const all = req.query.years === "all";
  const today = todayIso();
  const ev = await withContext(req.ctx!, (c) => buildEvaluation(c, req.ctx!.firmId!, pid, today));
  if (!ev) throw httpError(404, "Property not found.");
  if (!ev.years.length) throw httpError(409, "This property has no appeals yet, so there's nothing to evaluate.");
  const buf = await evaluationWorkbook(ev, pick(ev.years, all), today);
  const pin = ev.pins[0] ? shortPin(ev.pins[0].pin) : String(pid);
  const name = `${pin} - Evaluation Worksheet (${today.slice(0, 4)})${all ? " full history" : ""}.xlsx`.replace(/[\\/:*?"<>|]/g, "-");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="evaluation.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("Cache-Control", "private, no-store");
  res.end(buf);
});
