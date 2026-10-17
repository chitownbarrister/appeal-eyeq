import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closePool, getPool, query } from "./db.js";
import { hashPassword, PASSWORD_MIN_LENGTH } from "./auth.js";
import { seedSampleData } from "./seed/sample.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "db", "migrations");

/** Applies every migration not yet recorded in _migrations, in filename order. */
export async function runMigrations(log: (msg: string) => void = console.log): Promise<string[]> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  const applied = new Set((await pool.query<{ filename: string }>("SELECT filename FROM _migrations")).rows.map((r) => r.filename));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      log(`Migration applied: ${file}`);
      ran.push(file);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      log(`Migration FAILED: ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }
  if (ran.length === 0) log("Migrations: nothing new to apply");
  return ran;
}

/**
 * Creates the super admin account from environment variables, once.
 * Nothing happens if one already exists or the variables are not set.
 */
export async function ensureSuperAdmin(log: (msg: string) => void = console.log): Promise<void> {
  const email = process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.SUPER_ADMIN_PASSWORD;
  const existing = await query("SELECT 1 FROM users WHERE is_super_admin LIMIT 1");
  if (existing.rowCount) return;
  if (!email || !password) {
    log("Super admin: not created (set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD)");
    return;
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    log(`Super admin: not created (password must be at least ${PASSWORD_MIN_LENGTH} characters)`);
    return;
  }
  await query(
    `INSERT INTO users (firm_id, email, name, password_hash, role, is_super_admin) VALUES (NULL, lower($1), 'Super Admin', $2, NULL, true)`,
    [email, hashPassword(password)],
  );
  log("Super admin: created");
}

async function main(): Promise<void> {
  try {
    await runMigrations();
    await ensureSuperAdmin();
    if (process.env.SEED_SAMPLE_DATA === "true") {
      await seedSampleData(console.log);
    }
  } finally {
    await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error("Startup migration step failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
