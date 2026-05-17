import { describe, expect, it } from 'vitest';
import { createCalendarClient, createGmailClient } from '../src/google/index.js';
import { mockFetch } from './helpers.js';

describe('GmailClient', () => {
  it('listMessages returns message stubs', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { messages: [{ id: 'm1', threadId: 't1' }] },
    });
    const c = createGmailClient({ apiKey: 'tok', fetch });
    const out = await c.listMessages('is:unread');
    expect(out).toEqual([{ id: 'm1', threadId: 't1' }]);
    expect(calls[0]!.url).toContain('q=is%3Aunread');
  });

  it('sendMessage base64url-encodes the RFC 2822 envelope', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { id: 'm1', threadId: 't1' },
    });
    const c = createGmailClient({ apiKey: 'tok', fetch });
    await c.sendMessage('a@b.com', 'Hi', 'body');
    const body = JSON.parse(calls[0]!.body!);
    expect(typeof body.raw).toBe('string');
    expect(body.raw).not.toContain('+'); // base64url: no '+'
    expect(body.raw).not.toContain('/'); // base64url: no '/'
    expect(body.raw).not.toMatch(/=$/); // base64url: no padding
  });
});

describe('CalendarClient', () => {
  it('listUpcomingEvents requests singleEvents+orderBy and unwraps items', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { items: [{ id: 'e1', summary: 'Standup' }] },
    });
    const c = createCalendarClient({ apiKey: 'tok', fetch });
    const out = await c.listUpcomingEvents();
    expect(out).toHaveLength(1);
    expect(calls[0]!.url).toContain('singleEvents=true');
    expect(calls[0]!.url).toContain('orderBy=startTime');
    expect(calls[0]!.url).toContain('timeMin=');
  });
});
