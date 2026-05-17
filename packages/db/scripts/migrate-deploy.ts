/**
 * CI / deploy hook: applies pending Prisma migrations against the database
 * pointed to by `DATABASE_URL`.
 *
 * Usage (from CI):
 *   tsx packages/db/scripts/migrate-deploy.ts
 *
 * This is a thin shim around `prisma migrate deploy` — kept as a TS script so
 * we can wrap it with pre-flight checks (env var presence, target branch
 * sanity) as the project grows. Right now it only refuses to run without
 * `DATABASE_URL` and surfaces a clear non-zero exit on failure.
 *
 * NOTE: This script must NOT run interactive `prisma migrate dev` — that
 * generates new migration files and prompts for input. `migrate deploy` is
 * the production-safe sibling: it applies already-committed migrations and
 * fails fast on drift.
 */

import { spawn } from "node:child_process";
import process from "node:process";

function main(): void {
  if (!process.env["DATABASE_URL"]) {
    console.error(
      "[migrate-deploy] DATABASE_URL is not set. Refusing to run.",
    );
    process.exit(1);
  }

  const child = spawn("npx", ["prisma", "migrate", "deploy"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });

  child.on("error", (err) => {
    console.error("[migrate-deploy] failed to spawn prisma:", err);
    process.exit(1);
  });
}

main();
