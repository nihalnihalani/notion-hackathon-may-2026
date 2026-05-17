/**
 * Shared types for Google Workspace connectors (Gmail + Calendar).
 *
 * Both APIs use the same OAuth bearer flow and overlapping resource shapes,
 * so they live in one folder with separate factories.
 */

import { z } from 'zod';

// ── Gmail ────────────────────────────────────────────────────────────────────

export const gmailHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
});

export const gmailPayloadSchema = z.object({
  mimeType: z.string().optional(),
  headers: z.array(gmailHeaderSchema).optional(),
  body: z
    .object({
      size: z.number().optional(),
      data: z.string().optional(),
    })
    .optional(),
  parts: z.array(z.unknown()).optional(),
});

export const gmailMessageStubSchema = z.object({
  id: z.string(),
  threadId: z.string(),
});
export type GmailMessageStub = z.infer<typeof gmailMessageStubSchema>;

export const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
  internalDate: z.string().optional(),
  payload: gmailPayloadSchema.optional(),
});
export type GmailMessage = z.infer<typeof gmailMessageSchema>;

export const gmailListResponseSchema = z.object({
  messages: z.array(gmailMessageStubSchema).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});

export const gmailSendResponseSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
});
export type GmailSendResponse = z.infer<typeof gmailSendResponseSchema>;

// ── Calendar ─────────────────────────────────────────────────────────────────

export const calendarTimeSchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
});
export type CalendarTime = z.infer<typeof calendarTimeSchema>;

export const calendarAttendeeSchema = z.object({
  email: z.string(),
  displayName: z.string().optional(),
  responseStatus: z.string().optional(),
  optional: z.boolean().optional(),
});
export type CalendarAttendee = z.infer<typeof calendarAttendeeSchema>;

export const calendarEventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  htmlLink: z.string().url().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: calendarTimeSchema.optional(),
  end: calendarTimeSchema.optional(),
  attendees: z.array(calendarAttendeeSchema).optional(),
  organizer: z
    .object({ email: z.string().optional(), displayName: z.string().optional() })
    .optional(),
  hangoutLink: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export const calendarListResponseSchema = z.object({
  kind: z.string().optional(),
  items: z.array(calendarEventSchema).optional(),
  nextPageToken: z.string().optional(),
});
