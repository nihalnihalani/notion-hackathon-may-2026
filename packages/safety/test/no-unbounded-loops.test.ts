import { describe, it, expect } from 'vitest';
import { noUnboundedLoops } from '../src/rules/no-unbounded-loops.js';
import { runRule } from './helpers.js';

describe('no-unbounded-loops', () => {
  it('passes a normal for-loop', () => {
    const src = `
      for (let i = 0; i < 10; i++) {
        console.log(i);
      }
    `;
    expect(runRule(noUnboundedLoops, src)).toHaveLength(0);
  });

  // False-positive resistance: while(true) with a clear exit edge
  it('does not flag while(true) with break inside', () => {
    const src = `
      let i = 0;
      while (true) {
        if (i++ > 5) break;
      }
    `;
    expect(runRule(noUnboundedLoops, src)).toHaveLength(0);
  });

  it('does not flag while(true) with return inside', () => {
    const src = `
      function find() {
        while (true) {
          if (Math.random() > 0.99) return 1;
        }
      }
    `;
    expect(runRule(noUnboundedLoops, src)).toHaveLength(0);
  });

  it('does not flag while(true) with throw inside', () => {
    const src = `
      while (true) {
        throw new Error('stop');
      }
    `;
    expect(runRule(noUnboundedLoops, src)).toHaveLength(0);
  });

  it('warns on while(true) with NO exit', () => {
    const src = `
      while (true) {
        console.log('forever');
      }
    `;
    const v = runRule(noUnboundedLoops, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
  });

  it('warns on while(1) with no exit', () => {
    const src = `
      while (1) {
        console.log('forever');
      }
    `;
    const v = runRule(noUnboundedLoops, src);
    expect(v).toHaveLength(1);
  });

  it('warns on while(!0) with no exit', () => {
    const src = `
      while (!0) {
        console.log('forever');
      }
    `;
    const v = runRule(noUnboundedLoops, src);
    expect(v).toHaveLength(1);
  });

  it('warns on for(;;) with no exit', () => {
    const src = `
      for (;;) {
        console.log('forever');
      }
    `;
    const v = runRule(noUnboundedLoops, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
  });

  it('warns on do/while(true) with no exit', () => {
    const src = `
      do {
        console.log('forever');
      } while (true);
    `;
    const v = runRule(noUnboundedLoops, src);
    expect(v).toHaveLength(1);
  });

  it('does not flag while(condition) with variable test', () => {
    const src = `
      let cursor: string | null = 'start';
      while (cursor) {
        cursor = nextCursor(cursor);
      }
      function nextCursor(_: string): string | null { return null; }
    `;
    expect(runRule(noUnboundedLoops, src)).toHaveLength(0);
  });
});
