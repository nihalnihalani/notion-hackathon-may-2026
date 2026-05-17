/**
 * Stripe client.
 *
 * Auth: secret key as Bearer.
 * Body encoding: Stripe expects `application/x-www-form-urlencoded` for writes,
 * including nested fields via bracket notation. We handle that here so
 * generated code can pass plain objects.
 */

import { buildContext, makeRequest } from '../http.js';
import type { ConnectorConfig, RequestOptions } from '../types.js';
import {
  stripeChargeSchema,
  stripeCustomerSchema,
  stripeListSchema,
  stripeRefundSchema,
  stripeSubscriptionSchema,
  type StripeCharge,
  type StripeCustomer,
  type StripeRefund,
  type StripeSubscription,
} from './types.js';
import type { z } from 'zod';

const DEFAULT_BASE = 'https://api.stripe.com/v1';

function maybeValidate<T>(schema: z.ZodType<T>, data: unknown, validate?: boolean): T {
  return validate ? schema.parse(data) : (data as T);
}

/**
 * Encode a plain object as Stripe-flavoured form body. Supports nested objects
 * via bracket notation (`metadata[key]=value`) and arrays (`expand[0]=foo`).
 */
function encodeForm(body: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  const walk = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) walk(`${key}[${i}]`, v);
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(`${key}[${k}]`, v);
      }
      return;
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      params.append(key, String(value));
      return;
    }
    throw new TypeError(`Unsupported Stripe form value for '${key}'`);
  };
  for (const [k, v] of Object.entries(body)) walk(k, v);
  return params;
}

export interface StripeClient {
  listRecentCharges(limit?: number, opts?: RequestOptions): Promise<StripeCharge[]>;
  getCharge(id: string, opts?: RequestOptions): Promise<StripeCharge>;
  refundCharge(
    id: string,
    amount?: number,
    opts?: RequestOptions,
  ): Promise<StripeRefund>;
  getCustomer(id: string, opts?: RequestOptions): Promise<StripeCustomer>;
  listSubscriptions(
    customer?: string,
    opts?: RequestOptions,
  ): Promise<StripeSubscription[]>;
  getSubscription(id: string, opts?: RequestOptions): Promise<StripeSubscription>;
}

export function createStripeClient(config: ConnectorConfig): StripeClient {
  const ctx = buildContext({
    provider: 'stripe',
    authScheme: 'Bearer',
    config,
    defaultHeaders: {
      Accept: 'application/json',
      'Stripe-Version': '2024-11-20.acacia',
    },
  });
  const fullConfig: ConnectorConfig = {
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE,
  };

  const writeHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };

  return {
    async listRecentCharges(limit = 10, opts) {
      const data = await makeRequest<unknown>(
        '/charges',
        {
          method: 'GET',
          query: { limit },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(
        stripeListSchema(stripeChargeSchema),
        data,
        opts?.validate,
      );
      return parsed.data;
    },

    async getCharge(id, opts) {
      const data = await makeRequest<unknown>(
        `/charges/${encodeURIComponent(id)}`,
        { method: 'GET', ...(opts?.signal === undefined ? {} : { signal: opts.signal }) },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(stripeChargeSchema, data, opts?.validate);
    },

    async refundCharge(id, amount, opts) {
      const body: Record<string, unknown> = { charge: id };
      if (amount !== undefined) body['amount'] = amount;
      const data = await makeRequest<unknown>(
        '/refunds',
        {
          method: 'POST',
          headers: writeHeaders,
          body: encodeForm(body),
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(stripeRefundSchema, data, opts?.validate);
    },

    async getCustomer(id, opts) {
      const data = await makeRequest<unknown>(
        `/customers/${encodeURIComponent(id)}`,
        { method: 'GET', ...(opts?.signal === undefined ? {} : { signal: opts.signal }) },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(stripeCustomerSchema, data, opts?.validate);
    },

    async listSubscriptions(customer, opts) {
      const query: Record<string, string | number> = { limit: 100 };
      if (customer !== undefined) query['customer'] = customer;
      const data = await makeRequest<unknown>(
        '/subscriptions',
        {
          method: 'GET',
          query,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(
        stripeListSchema(stripeSubscriptionSchema),
        data,
        opts?.validate,
      );
      return parsed.data;
    },

    async getSubscription(id, opts) {
      const data = await makeRequest<unknown>(
        `/subscriptions/${encodeURIComponent(id)}`,
        { method: 'GET', ...(opts?.signal === undefined ? {} : { signal: opts.signal }) },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(stripeSubscriptionSchema, data, opts?.validate);
    },
  };
}
