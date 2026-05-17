/**
 * Baseline I/O + regression detection.
 *
 * Layout on disk:
 *
 *   evals/baselines.json
 *
 * Shape:
 *   {
 *     "updatedAt":    "2025-05-17T03:00:00Z",
 *     "updatedFromRun": "<github run id>",
 *     "agents": {
 *       "<agent>": { "passRate": 0.95, "totalCases": 11 }
 *     }
 *   }
 *
 * A baseline `passRate` of `null` means "no baseline yet" — the first
 * green nightly run should call `baseline:update` to seed it. Until then,
 * `baseline:check` treats any pass-rate as acceptable.
 *
 * Regression rule (default 5pp): a sub-agent regresses if its current
 * passRate is less than `baseline.passRate - threshold / 100`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_NAMES, type AgentName } from './agents.js';
import type { EvalRunResult } from './runner.js';

export interface AgentBaseline {
  passRate: number | null;
  totalCases: number;
}

export interface Baseline {
  updatedAt: string | null;
  updatedFromRun: string | null;
  agents: Record<AgentName, AgentBaseline>;
}

export interface BaselineDiff {
  regressed: boolean;
  thresholdPct: number;
  summary: string;
  perAgent: {
    agent: AgentName;
    baseline: number | null;
    current: number | null;
    deltaPct: number | null;
    regressed: boolean;
  }[];
}

function defaultBaselinePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'evals', 'baselines.json');
}

export function readBaseline(path: string = defaultBaselinePath()): Baseline {
  if (!existsSync(path)) {
    return emptyBaseline();
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Baseline> & Record<string, unknown>;
    const agents = (parsed.agents ?? {}) as Record<string, AgentBaseline>;
    const merged = emptyBaseline();
    merged.updatedAt = parsed.updatedAt ?? null;
    merged.updatedFromRun = parsed.updatedFromRun ?? null;
    for (const name of AGENT_NAMES) {
      const v = agents[name];
      if (v && typeof v === 'object') {
        merged.agents[name] = {
          passRate: typeof v.passRate === 'number' ? v.passRate : null,
          totalCases: typeof v.totalCases === 'number' ? v.totalCases : 0,
        };
      }
    }
    return merged;
  } catch (err) {
    throw new Error(`failed to read baseline at ${path}: ${(err as Error).message}`);
  }
}

export function writeBaseline(
  result: EvalRunResult,
  opts: { path?: string; runId?: string } = {},
): Baseline {
  const baseline = emptyBaseline();
  baseline.updatedAt = new Date().toISOString();
  baseline.updatedFromRun = opts.runId ?? null;
  for (const r of result.results) {
    baseline.agents[r.agent] = { passRate: r.passRate, totalCases: r.totalCases };
  }
  writeFileSync(opts.path ?? defaultBaselinePath(), JSON.stringify(baseline, null, 2) + '\n');
  return baseline;
}

/**
 * Compare a run to the baseline. `thresholdPct` is in percentage POINTS
 * (5 means "5pp drop", not "5%"). Returns a {@link BaselineDiff} which is
 * directly serializable to the GHA output the nightly workflow expects.
 */
export function compareToBaseline(
  result: EvalRunResult,
  baseline: Baseline,
  thresholdPct = 5,
): BaselineDiff {
  const perAgent: BaselineDiff['perAgent'] = [];
  for (const r of result.results) {
    const base = baseline.agents[r.agent]?.passRate ?? null;
    const cur = r.passRate;
    let deltaPct: number | null = null;
    let regressed = false;
    if (base !== null && cur !== null) {
      deltaPct = (cur - base) * 100;
      regressed = deltaPct < -thresholdPct;
    }
    perAgent.push({ agent: r.agent, baseline: base, current: cur, deltaPct, regressed });
  }
  const regressed = perAgent.some((a) => a.regressed);
  const summary = perAgent
    .map((a) => {
      const baseStr = a.baseline === null ? 'n/a' : `${(a.baseline * 100).toFixed(1)}%`;
      const curStr = a.current === null ? 'n/a' : `${(a.current * 100).toFixed(1)}%`;
      const deltaStr = a.deltaPct === null ? '' : ` (${a.deltaPct > 0 ? '+' : ''}${a.deltaPct.toFixed(1)}pp)`;
      const flag = a.regressed ? ' REGRESSED' : '';
      return `${a.agent}: ${curStr} vs baseline ${baseStr}${deltaStr}${flag}`;
    })
    .join('\n');
  return { regressed, thresholdPct, summary, perAgent };
}

function emptyBaseline(): Baseline {
  const agents = {} as Record<AgentName, AgentBaseline>;
  for (const name of AGENT_NAMES) {
    agents[name] = { passRate: null, totalCases: 0 };
  }
  return { updatedAt: null, updatedFromRun: null, agents };
}
