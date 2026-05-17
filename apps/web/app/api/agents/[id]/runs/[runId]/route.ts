/**
 * GET /api/agents/[id]/runs/[runId] — fetch the post-execution logs for a
 * single NTN run.
 *
 * The wrapper's `getRunLogs` calls `ntn workers runs logs <runId>` and
 * returns the captured stdout as a single string plus a line-split copy.
 * The dashboard's "Run logs" pane renders the raw text in a `<pre>`, so
 * we forward the full string here. To keep the response small enough for
 * a single response body we also surface a few metadata fields by
 * re-fetching the run from `listRuns` (cheap — that's a single JSON
 * fetch). Doing the lookup server-side keeps the FE simpler.
 *
 * Auth + ownership match the list route — `requireAgentOwnership`
 * collapses unknown agents to 404.
 *
 * Response envelope:
 *   { runId, logs, exitCode, startedAt, durationMs, status }
 */

import { getRunLogs, listRuns, NtnNotInstalledError } from '@forge/ntn-wrapper';
import type { WorkerRun } from '@forge/ntn-wrapper';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { requireAgentOwnership } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// NTN's runId regex is a strict subset of [A-Za-z0-9_-]; we re-validate
// here so a malformed param triggers a 400 before we shell out.
const RUN_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export const GET = withSentry<{ id: string; runId: string }>(
  async (_req, ctx) => {
    const { id, runId } = await ctx.params;
    if (!RUN_ID_REGEX.test(runId)) {
      return apiError('validation', 'Invalid runId.');
    }

    const auth = await requireAgentOwnership(id);
    if (!auth.ok) return auth.response;
    const { agent } = auth;

    // Pull the run metadata + the log body in parallel. `listRuns` is the
    // only way we have today to read `exitCode`/`startedAt`/`durationMs` —
    // the dedicated `logs` subcommand returns text only.
    let logsResult: { logs: string; lines: string[] };
    let runMeta: WorkerRun | undefined;
    try {
      const [logs, runs] = await Promise.all([
        getRunLogs(agent.ntnWorkerName, runId),
        listRuns(agent.ntnWorkerName, { limit: 200 }),
      ]);
      logsResult = logs;
      runMeta = runs.find((r) => r.id === runId);
    } catch (err) {
      if (err instanceof NtnNotInstalledError) {
        Sentry.captureException(err, {
          tags: { phase: 'ntn.getRunLogs', ntnWorkerName: agent.ntnWorkerName },
        });
        return apiError('upstream_failure', 'ntn CLI not available.');
      }
      const message = err instanceof Error ? err.message.toLowerCase() : '';
      if (message.includes('not found') || message.includes('404')) {
        return apiError('not_found', `Run ${runId} not found.`);
      }
      Sentry.captureException(err, {
        tags: { phase: 'ntn.getRunLogs', ntnWorkerName: agent.ntnWorkerName },
      });
      return apiError('upstream_failure', 'ntn getRunLogs failed.');
    }

    const rawExit = runMeta
      ? (runMeta as { exitCode?: unknown }).exitCode
      : undefined;
    const exitCode = typeof rawExit === 'number' ? rawExit : null;

    return NextResponse.json({
      runId,
      logs: logsResult.logs,
      lines: logsResult.lines,
      exitCode,
      status: runMeta?.status ?? null,
      startedAt: runMeta?.startedAt ?? null,
      durationMs:
        runMeta && typeof runMeta.durationMs === 'number'
          ? runMeta.durationMs
          : null,
    });
  },
  { routeName: 'agents.runs.logs' },
);
