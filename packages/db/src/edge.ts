/**
 * Edge-runtime Prisma client.
 *
 * Import from `@forge/db/edge` in files that declare
 * `export const runtime = "edge"` (Next.js route handlers, middleware-adjacent
 * code). For Node runtimes use `@forge/db/client` (or the top-level
 * `@forge/db`) instead.
 *
 * Runtime split
 * -------------
 *   - `client.ts`  → Node only. Uses Prisma's binary query engine over a
 *                    regular `pg` socket pool. Cannot run on the Edge.
 *   - `edge.ts`    → Edge-compatible. Uses `@prisma/adapter-pg`, which talks
 *                    to a Neon-compatible Postgres endpoint over HTTP/WS so it
 *                    works in V8 isolates (no Node `net` module needed).
 *
 * PlanetScale on Postgres exposes a Neon-compatible endpoint, so the same
 * adapter works. Set `DATABASE_URL` to the pooled connection string from
 * PlanetScale; do NOT use the direct-connection URL from Edge — it will not
 * survive cold starts under load.
 *
 * Hot-reload safety
 * -----------------
 * The Edge runtime does not have a stable `globalThis` across HMR reloads in
 * dev (each request gets a fresh isolate), so the Node-style global cache used
 * by `client.ts` is unnecessary and we construct a fresh client per request.
 * The HTTP adapter does not hold long-lived sockets, so this is cheap.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

const isProd = process.env["NODE_ENV"] === "production";

/**
 * Create an Edge-runtime-safe PrismaClient.
 *
 * Pass an explicit `connectionString` to override the default `DATABASE_URL`.
 * This is useful for tests or when routing reads to a replica.
 *
 * The returned client has the exact same API surface as the Node client —
 * `prisma.workspace.findUnique(...)`, transactions, etc. all work.
 */
export function createEdgePrisma(options?: {
  connectionString?: string;
}): PrismaClient {
  const connectionString =
    options?.connectionString ?? process.env["DATABASE_URL"];

  if (!connectionString) {
    throw new Error(
      "[@forge/db/edge] DATABASE_URL is not set. Refusing to build an edge client without a connection string.",
    );
  }

  // A pool size of 1 is correct for Edge: each isolate handles one request at
  // a time and we want to release the connection back to PlanetScale as soon
  // as the request completes. Larger pools just hold open sockets we cannot
  // use concurrently.
  const pool = new Pool({ connectionString, max: 1 });
  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
    log: isProd
      ? [
          { emit: "stdout", level: "warn" },
          { emit: "stdout", level: "error" },
        ]
      : [
          { emit: "stdout", level: "query" },
          { emit: "stdout", level: "warn" },
          { emit: "stdout", level: "error" },
        ],
    errorFormat: isProd ? "minimal" : "pretty",
  });
}
