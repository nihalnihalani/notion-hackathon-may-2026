import { describe, expect, it } from 'vitest';
import { createStripeClient } from '../src/stripe/index.js';
import { mockFetch } from './helpers.js';

const charge = {
  id: 'ch_1',
  object: 'charge',
  amount: 1000,
  currency: 'usd',
  status: 'succeeded',
  paid: true,
  refunded: false,
  customer: 'cus_1',
  description: null,
  created: 1700000000,
  receipt_url: null,
};

describe('StripeClient', () => {
  it('listRecentCharges unwraps the Stripe list envelope', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'list', data: [charge], has_more: false },
    });
    const c = createStripeClient({ apiKey: 'sk_test', fetch });
    const out = await c.listRecentCharges(5);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('ch_1');
    expect(calls[0]!.url).toContain('limit=5');
  });

  it('refundCharge encodes form body', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        id: 're_1',
        object: 'refund',
        amount: 500,
        currency: 'usd',
        charge: 'ch_1',
        status: 'succeeded',
        reason: null,
        created: 1700000000,
      },
    });
    const c = createStripeClient({ apiKey: 'sk_test', fetch });
    const out = await c.refundCharge('ch_1', 500);
    expect(out.id).toBe('re_1');
    expect(calls[0]!.headers['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(calls[0]!.body).toBe('charge=ch_1&amount=500');
  });
});
