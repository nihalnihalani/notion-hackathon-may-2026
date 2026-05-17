/**
 * Stripe response types — minimal field set used by generated agents.
 *
 * Stripe wraps lists as `{ object: 'list', data: T[], has_more: boolean, ... }`.
 * Methods unwrap to `T[]` for ergonomic generated code.
 */

import { z } from 'zod';

export const stripeChargeSchema = z.object({
  id: z.string(),
  object: z.literal('charge').optional(),
  amount: z.number(),
  currency: z.string(),
  status: z.string(),
  paid: z.boolean().optional(),
  refunded: z.boolean().optional(),
  customer: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  created: z.number(),
  receipt_url: z.string().nullable().optional(),
});
export type StripeCharge = z.infer<typeof stripeChargeSchema>;

export const stripeRefundSchema = z.object({
  id: z.string(),
  object: z.literal('refund').optional(),
  amount: z.number(),
  currency: z.string(),
  charge: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  created: z.number(),
});
export type StripeRefund = z.infer<typeof stripeRefundSchema>;

export const stripeCustomerSchema = z.object({
  id: z.string(),
  object: z.literal('customer').optional(),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  created: z.number(),
});
export type StripeCustomer = z.infer<typeof stripeCustomerSchema>;

export const stripeSubscriptionSchema = z.object({
  id: z.string(),
  object: z.literal('subscription').optional(),
  customer: z.string(),
  status: z.string(),
  current_period_start: z.number().optional(),
  current_period_end: z.number().optional(),
  cancel_at_period_end: z.boolean().optional(),
  created: z.number(),
});
export type StripeSubscription = z.infer<typeof stripeSubscriptionSchema>;

export const stripeListSchema = <T extends z.ZodTypeAny>(item: T): z.ZodObject<{
  object: z.ZodLiteral<'list'>;
  data: z.ZodArray<T>;
  has_more: z.ZodBoolean;
}> =>
  z.object({
    object: z.literal('list'),
    data: z.array(item),
    has_more: z.boolean(),
  });
