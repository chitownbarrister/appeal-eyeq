import { defineConfig } from "@playwright/test";

// End-to-end tests drive the real built app (npm run build first) in Chromium,
// against a throwaway database that is wiped and re-seeded on every run.
const E2E_DB = process.env.E2E_DATABASE_URL || "postgres://appeal:appeal@localhost/appeal_e2e";
const env = {
  DATABASE_URL: E2E_DB,
  PORT: "3100",
  SUPER_ADMIN_EMAIL: "admin@appealeyeq.example",
  SUPER_ADMIN_PASSWORD: "superadmin-pass-1",
  SEED_SAMPLE_DATA: "true",
  SAMPLE_USER_PASSWORD: "sample-pass-1",
  APP_TODAY: "2026-10-19", // the sample windows and deadlines are dated around this day
};

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: `psql "${E2E_DB}" -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" && node dist/server/migrate.js && node dist/server/index.js`,
    url: "http://127.0.0.1:3100/api/health",
    env,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
