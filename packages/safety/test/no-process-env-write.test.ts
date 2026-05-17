import { describe, it, expect } from 'vitest';
import { noProcessEnvWrite } from '../src/rules/no-process-env-write.js';
import { runRule } from './helpers.js';

describe('no-process-env-write', () => {
  it('passes clean code that reads process.env', () => {
    const src = `
      const k = process.env.NOTION_KEY;
      const x = process.env['OTHER'];
      console.log(k, x);
    `;
    expect(runRule(noProcessEnvWrite, src)).toHaveLength(0);
  });

  // False-positive resistance
  it('does not flag user-defined env objects', () => {
    const src = `
      const config = { env: { FOO: 'bar' } };
      config.env.FOO = 'changed';
      const env = { x: 1 };
      env.x = 2;
      delete env.x;
    `;
    expect(runRule(noProcessEnvWrite, src)).toHaveLength(0);
  });

  it('warns on process.env.X = ...', () => {
    const src = `process.env.NOTION_KEY = 'leaked';`;
    const v = runRule(noProcessEnvWrite, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
  });

  it('warns on process.env["X"] = ...', () => {
    const src = `process.env['NOTION_KEY'] = 'leaked';`;
    const v = runRule(noProcessEnvWrite, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
  });

  it('warns on delete process.env.X', () => {
    const src = `delete process.env.NOTION_KEY;`;
    const v = runRule(noProcessEnvWrite, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
  });

  it('warns on Object.assign(process.env, ...)', () => {
    const src = `Object.assign(process.env, { FOO: 'bar' });`;
    const v = runRule(noProcessEnvWrite, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
  });

  it('does not flag Object.assign on other targets', () => {
    const src = `Object.assign({}, { foo: 'bar' });`;
    expect(runRule(noProcessEnvWrite, src)).toHaveLength(0);
  });
});
