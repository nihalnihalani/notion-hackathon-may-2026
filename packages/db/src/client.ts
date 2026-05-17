/**
 * Node.js (server) Prisma client singleton.
 *
 * This module is the canonical entry point for any code running on a Node
 * runtime: Next.js route handlers with `export const runtime = "nodejs"`,
 * Vercel Workflow tasks, scripts, etc.
 *
 * For Edge runtimes import from `@forge/db/edge` instead — it uses a
 * different driver (pg over Neon-compatible HTTP/WebSocket adapter) because
 * the standard Prisma binary engine is not available on the Edge.
 *
 * Hot-reload safety:
 *   Next.js dev mode reloads modules on every change. Without a global guard,
 *   each reload constructs a new PrismaClient and (because PlanetScale's pool
 *   is small) we exhaust connections within seconds. We stash the client on
 *   `globalThis.__forge_prisma__` and reuse it across reloads.
 */

import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __forge_prisma__: PrismaClient | undefined;
}

const isProd = process.env["NODE_ENV"] === "production";

/**
 * Build a PrismaClient with PlanetScale-friendly defaults.
 *
 * - Logging: warn/error always, info always (we want operational signals in
 *   prod logs), query only in dev (too noisy + leaks query shape in prod logs).
 * - We do NOT call `$connect()` here; Prisma lazily opens connections on first
 *   query, which is the right behavior for serverless cold starts.
 */
function buildClient(): PrismaClient {
  return new PrismaClient({
    log: isProd
      ? [
          { emit: "stdout", level: "info" },
          { emit: "stdout", level: "warn" },
          { emit: "stdout", level: "error" },
        ]
      : [
          { emit: "stdout", level: "query" },
          { emit: "stdout", level: "info" },
          { emit: "stdout", level: "warn" },
          { emit: "stdout", level: "error" },
        ],
    errorFormat: isProd ? "minimal" : "pretty",
  });
}

/**
 * The shared PrismaClient instance.
 *
 * In dev we cache it on `globalThis` to survive Next.js HMR. In prod each
 * serverless invocation gets its own module instance, so the global guard is a
 * harmless no-op there.
 */
export const prisma: PrismaClient =
  globalThis.__forge_prisma__ ?? buildClient();

if (!isProd) {
  globalThis.__forge_prisma__ = prisma;
}

/**
 * Gracefully close the connection pool.
 *
 * Call from CLI scripts and long-running workers on shutdown. Serverless
 * functions should NOT call this — the platform handles teardown and calling
 * `$disconnect()` between invocations defeats Prisma's connection reuse.
 */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
