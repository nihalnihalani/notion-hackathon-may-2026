import { describe, it, expect } from 'vitest';
import { noChildProcess } from '../src/rules/no-child-process.js';
import { runRule } from './helpers.js';

describe('no-child-process', () => {
  it('passes clean Worker code that uses notion client', () => {
    const src = `
      import { Client } from '@notionhq/client';
      const notion = new Client({ auth: 'x' });
      export default async () => notion.pages.create({});
    `;
    expect(runRule(noChildProcess, src)).toHaveLength(0);
  });

  // False-positive resistance: variable named "child_process" / "exec" used as a STRING is not a call.
  it('does not flag identifiers that happen to be named like the forbidden APIs', () => {
    const src = `
      const child_process = "this is just a label";
      const obj = { exec: () => 1 };
      const e = obj.exec();
      const description = "use child_process to spawn things — DON'T";
      export { e, description };
    `;
    // obj.exec() is not process.exec — must not flag
    expect(runRule(noChildProcess, src)).toHaveLength(0);
  });

  it('blocks ImportDeclaration of child_process', () => {
    const src = `import { exec } from 'child_process';`;
    const v = runRule(noChildProcess, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
    expect(v[0]?.rule).toBe('no-child-process');
  });

  it('blocks ImportDeclaration of node:child_process', () => {
    const src = `import { spawn } from 'node:child_process';`;
    const v = runRule(noChildProcess, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
  });

  it('blocks require("child_process")', () => {
    const src = `const cp = require('child_process'); cp.exec('ls');`;
    const v = runRule(noChildProcess, src);
    // require + process.exec — could be 1 (require only — process.exec is on a local) or 2.
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0]?.message).toMatch(/child_process/);
  });

  it('blocks dynamic import("child_process")', () => {
    const src = `await import('child_process');`;
    const v = runRule(noChildProcess, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
  });

  it('blocks process.exec/spawn/execSync member access', () => {
    const src = `
      process.exec('ls');
      process.spawn('cat', ['/etc/passwd']);
      process.execSync('rm -rf /');
    `;
    const v = runRule(noChildProcess, src);
    expect(v.length).toBeGreaterThanOrEqual(3);
    for (const violation of v) {
      expect(violation.severity).toBe('block');
    }
  });

  it('does not flag process.env reads or process.cwd()', () => {
    const src = `
      const k = process.env.NOTION_KEY;
      const cwd = process.cwd();
      const ver = process.version;
      export { k, cwd, ver };
    `;
    expect(runRule(noChildProcess, src)).toHaveLength(0);
  });

  it('captures line and column metadata correctly', () => {
    const src = `// header\nimport { exec } from 'child_process';`;
    const v = runRule(noChildProcess, src);
    expect(v[0]?.line).toBe(2);
    expect(v[0]?.column).toBeGreaterThan(0);
    expect(v[0]?.snippet).toContain('child_process');
  });
});
