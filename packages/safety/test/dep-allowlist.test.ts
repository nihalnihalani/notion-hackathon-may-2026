import { describe, it, expect } from 'vitest';
import { checkPackageJson } from '../src/rules/dep-allowlist.js';
import { TEST_OPTS } from './helpers.js';

describe('dep-allowlist', () => {
  it('passes a clean package.json with only allowlisted deps', () => {
    const pkg = {
      name: 'generated-agent',
      dependencies: {
        '@notionhq/client': '^3.0.0',
        'zod': '^3.23.0',
      },
      devDependencies: {
        'typescript': '5.7.2', // NOT on the allowlist — should block
      },
    };
    const v = checkPackageJson(pkg, TEST_OPTS);
    // The typescript dev dep should fail
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('typescript');
  });

  it('passes when only allowlisted devDeps present', () => {
    const pkg = {
      dependencies: { '@notionhq/client': '^3.0.0' },
      devDependencies: { 'date-fns': '^3.0.0' },
    };
    const v = checkPackageJson(pkg, TEST_OPTS);
    expect(v).toHaveLength(0);
  });

  it('blocks unknown runtime dep', () => {
    const pkg = {
      dependencies: { 'request': '^2.88.2', '@notionhq/client': '^3.0.0' },
    };
    const v = checkPackageJson(pkg, TEST_OPTS);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
    expect(v[0]?.message).toContain('request');
  });

  it('blocks multiple unknown deps at once', () => {
    const pkg = {
      dependencies: {
        'lodash': '^4.0.0',
        'underscore': '^1.0.0',
        '@notionhq/client': '^3.0.0',
      },
    };
    const v = checkPackageJson(pkg, TEST_OPTS);
    expect(v).toHaveLength(2);
    const names = v.map((x) => x.message);
    expect(names.some((n) => n.includes('lodash'))).toBe(true);
    expect(names.some((n) => n.includes('underscore'))).toBe(true);
  });

  it('handles missing dependencies / devDependencies blocks', () => {
    expect(checkPackageJson({}, TEST_OPTS)).toHaveLength(0);
    expect(checkPackageJson({ dependencies: undefined }, TEST_OPTS)).toHaveLength(0);
    expect(checkPackageJson({ dependencies: null }, TEST_OPTS)).toHaveLength(0);
  });

  it('respects caller-provided allowlist', () => {
    const pkg = { dependencies: { 'undici': '^6.0.0' } };
    const v = checkPackageJson(pkg, {
      ...TEST_OPTS,
      depAllowlist: ['undici'],
    });
    expect(v).toHaveLength(0);
  });

  it('ignores non-object dependency blocks (defensive)', () => {
    const pkg = { dependencies: 'oops' };
    expect(checkPackageJson(pkg, TEST_OPTS)).toHaveLength(0);
  });
});
