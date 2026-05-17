import { describe, it, expect } from 'vitest';
import { noEval } from '../src/rules/no-eval.js';
import { runRule } from './helpers.js';

describe('no-eval', () => {
  it('passes clean code with no dynamic eval', () => {
    const src = `
      const x = JSON.parse('{"a":1}');
      const fn = (n: number) => n * 2;
      fn(x.a);
    `;
    expect(runRule(noEval, src)).toHaveLength(0);
  });

  // False-positive resistance: variable named `eval`/`Function` used inert
  it('does not flag identifiers that share names with forbidden APIs when not called', () => {
    const src = `
      const Function = "this is a string";
      const evaluator = { name: 'eval' };
      const description = "we used to use eval() but no more";
      export { Function, evaluator, description };
    `;
    expect(runRule(noEval, src)).toHaveLength(0);
  });

  it('blocks eval(...)', () => {
    const src = `eval('2 + 2');`;
    const v = runRule(noEval, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
    expect(v[0]?.message).toMatch(/eval/);
  });

  it('blocks globalThis.eval(...)', () => {
    const src = `globalThis.eval('bad()');`;
    const v = runRule(noEval, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
  });

  it('blocks new Function(...)', () => {
    const src = `const fn = new Function('a', 'b', 'return a + b');`;
    const v = runRule(noEval, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
    expect(v[0]?.message).toMatch(/Function/);
  });

  it('blocks dynamic import with template literal containing expression', () => {
    const src = `
      const name = 'foo';
      const mod = await import(\`@notionhq/\${name}\`);
    `;
    const v = runRule(noEval, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
  });

  it('blocks dynamic import with identifier argument', () => {
    const src = `
      const path = './foo.js';
      const mod = await import(path);
    `;
    const v = runRule(noEval, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
  });

  it('allows dynamic import with plain static string', () => {
    const src = `const m = await import('@notionhq/client');`;
    expect(runRule(noEval, src)).toHaveLength(0);
  });

  it('does not flag new Foo() that happens to look like Function', () => {
    const src = `
      class FunctionLike { run() {} }
      const f = new FunctionLike();
      f.run();
    `;
    expect(runRule(noEval, src)).toHaveLength(0);
  });
});
