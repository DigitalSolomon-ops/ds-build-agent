/**
 * Load a local, git-ignored `.env` (KEY=VALUE lines) into process.env before
 * anything reads it. Imported FIRST in server.ts so ANTHROPIC_API_KEY and the
 * DS_* overrides can live in a file instead of being exported each session.
 *
 * A missing or malformed `.env` is fine — it's optional; we fall back to the
 * real environment. Secrets never enter source: `.env` is git-ignored.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// dist/dashboard/load-env.js → repo root is two levels up.
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", "..", ".env");

// `process.loadEnvFile` exists on Node >=20.12; guard + cast so an older
// runtime (or missing types) never breaks the build or boot.
const loadEnvFile = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile;

if (loadEnvFile && existsSync(envPath)) {
  try {
    loadEnvFile(envPath);
  } catch {
    /* malformed/unreadable .env — ignore and use the real environment */
  }
}
