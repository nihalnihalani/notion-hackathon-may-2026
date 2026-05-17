/**
 * Typed wrapper for `ntn doctor --json` — used by `scripts/setup.sh` and
 * `lib/diagnostics.ts` per PLAN.md §III.
 */

import { runNtn, runNtnJson } from './exec';
import { NtnExecError } from './errors';
import type { DoctorReport, NtnRunOptions } from './types';

interface RawDoctorJson {
  ok?: boolean;
  loggedIn?: boolean;
  logged_in?: boolean;
  version?: string;
  cliVersion?: string;
  cli_version?: string;
  checks?: {
    name?: string;
    ok?: boolean;
    pass?: boolean;
    message?: string;
    detail?: string;
  }[];
  [key: string]: unknown;
}

/**
 * Run `ntn doctor --json` and normalise the result into `DoctorReport`.
 *
 * If `--json` is unsupported by the installed CLI, we fall back to plain
 * `ntn doctor` and surface a degraded report with `ok: false` and the raw
 * stdout in `checks[0].message` so callers can still display something.
 *
 * Doctor failures (non-zero exit) are not thrown — they're returned as
 * `ok: false`. That matches how the CLI signals "your install is unhealthy"
 * and lets diagnostics surface the failure to the user.
 */
export async function runDoctor(opts: NtnRunOptions = {}): Promise<DoctorReport> {
  try {
    const { data } = await runNtnJson<RawDoctorJson>(['doctor', '--json'], opts);
    return normalise(data);
  } catch (error) {
    // Older CLI versions may exit non-zero with `--json` if the install is
    // unhealthy. Try to recover the JSON from the exec error's stdout.
    if (error instanceof NtnExecError) {
      try {
        const parsed: unknown = JSON.parse(error.stdout.trim());
        return normalise(parsed as RawDoctorJson);
      } catch {
        // Fall through to the plain-text fallback below.
      }
      return {
        ok: false,
        checks: [
          {
            name: 'ntn doctor',
            ok: false,
            message: (error.stderr || error.stdout || error.message).slice(0, 4000),
          },
        ],
        raw: { stderr: error.stderr, stdout: error.stdout, exitCode: error.exitCode },
      };
    }
    throw error;
  }
}

function normalise(raw: RawDoctorJson): DoctorReport {
  const checks = (raw.checks ?? []).map((c) => {
    const ok = c.ok ?? c.pass ?? false;
    const message = c.message ?? c.detail;
    return {
      name: c.name ?? 'unknown',
      ok,
      ...(message === undefined ? {} : { message }),
    };
  });

  const ok = raw.ok ?? (checks.length > 0 ? checks.every((c) => c.ok) : false);

  const loggedIn = raw.loggedIn ?? raw.logged_in;
  const cliVersion = raw.cliVersion ?? raw.cli_version ?? raw.version;

  return {
    ok,
    ...(loggedIn === undefined ? {} : { loggedIn }),
    ...(cliVersion === undefined ? {} : { cliVersion }),
    checks,
    raw: raw as unknown,
  };
}

/**
 * Run `ntn doctor` without `--json` (human-readable). Useful when surfacing
 * the doctor output directly to a user.
 */
export async function runDoctorRaw(opts: NtnRunOptions = {}): Promise<string> {
  const result = await runNtn(['doctor'], opts);
  return result.stdout;
}
