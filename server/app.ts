import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { loadAuth } from "./auth.js";
import { query } from "./db.js";
import { authRouter } from "./routes/auth.js";
import { firmRouter } from "./routes/firm.js";
import { adminRouter } from "./routes/admin.js";
import { referenceRouter } from "./routes/reference.js";

export function createApp(): express.Express {
  const app = express();
  app.set("trust proxy", 1); // Render terminates TLS in front of the app
  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),
    );
    next();
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(loadAuth);

  // State-changing API calls must come from our own pages (blocks cross-site form posts).
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    // A bodiless DELETE can't come from a cross-site form (forms only GET/POST), and
    // browsers preflight cross-site DELETEs, which this server never approves.
    const hasBody = Number(req.headers["content-length"] || 0) > 0 || req.headers["transfer-encoding"] !== undefined;
    if (req.method === "DELETE" && !hasBody) return next();
    if (!req.is("application/json")) {
      res.status(415).json({ error: "Send JSON." });
      return;
    }
    next();
  });

  app.get("/api/health", async (_req, res) => {
    await query("SELECT 1");
    res.json({ ok: true });
  });
  app.use("/api/auth", authRouter);
  app.use("/api/firm", firmRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/reference", referenceRouter);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // The built web app, with client-side routes falling back to index.html.
  const webDir = path.resolve(process.cwd(), "dist", "web");
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(webDir, "index.html"));
    });
  }

  // Errors: log the route and error type only, never request bodies or client data.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; publicMessage?: string; code?: string };
    if (e?.status && e.publicMessage) {
      res.status(e.status).json({ error: e.publicMessage });
      return;
    }
    const name = err instanceof Error ? err.name : "Error";
    const code = e?.code;
    console.error(`Request failed: ${req.method} ${req.path} ${name}${code ? ` (${code})` : ""}`);
    if (code === "42501") {
      res.status(403).json({ error: "Not permitted." });
      return;
    }
    if (code === "23503") {
      res.status(400).json({ error: "A linked record (client, user, parcel or county) doesn't exist in your firm." });
      return;
    }
    if (code === "23505") {
      res.status(409).json({ error: "That already exists. A PIN can only be on one property in your firm." });
      return;
    }
    if (code === "22P02" || code === "22003" || code === "23514") {
      res.status(400).json({ error: "One of the values isn't valid." });
      return;
    }
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  return app;
}
