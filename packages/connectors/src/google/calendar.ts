/**
 * Google Calendar API client.
 *
 * Auth: OAuth access token as Bearer.
 */

import { buildContext, makeRequest } from '../http.js';
import type { ConnectorConfig, RequestOptions } from '../types.js';
import {
  calendarEventSchema,
  calendarListResponseSchema,
  type CalendarAttendee,
  type CalendarEvent,
  type CalendarTime,
} from './types.js';
import { z } from 'zod';

const DEFAULT_BASE = 'https://www.googleapis.com/calendar/v3';

function maybeValidate<T>(schema: z.ZodType<T>, data: unknown, validate?: boolean): T {
  return validate ? schema.parse(data) : (data as T);
}

export interface CreateCalendarEventParams {
  summary: string;
  description?: string;
  location?: string;
  start: CalendarTime;
  end: CalendarTime;
  attendees?: CalendarAttendee[];
  sendUpdates?: 'all' | 'externalOnly' | 'none';
}

export interface CalendarClient {
  listUpcomingEvents(
    calendarId?: string,
    maxResults?: number,
    opts?: RequestOptions,
  ): Promise<CalendarEvent[]>;
  getEvent(
    calendarId: string,
    id: string,
    opts?: RequestOptions,
  ): Promise<CalendarEvent>;
  createEvent(
    calendarId: string,
    params: CreateCalendarEventParams,
    opts?: RequestOptions,
  ): Promise<CalendarEvent>;
}

export function createCalendarClient(config: ConnectorConfig): CalendarClient {
  const ctx = buildContext({
    provider: 'google-calendar',
    authScheme: 'Bearer',
    config,
    defaultHeaders: { Accept: 'application/json' },
  });
  const fullConfig: ConnectorConfig = {
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE,
  };

  return {
    async listUpcomingEvents(calendarId = 'primary', maxResults = 25, opts) {
      const data = await makeRequest<unknown>(
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          method: 'GET',
          query: {
            maxResults,
            singleEvents: true,
            orderBy: 'startTime',
            timeMin: new Date().toISOString(),
          },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(calendarListResponseSchema, data, opts?.validate);
      return parsed.items ?? [];
    },

    async getEvent(calendarId, id, opts) {
      const data = await makeRequest<unknown>(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`,
        { method: 'GET', ...(opts?.signal === undefined ? {} : { signal: opts.signal }) },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(calendarEventSchema, data, opts?.validate);
    },

    async createEvent(calendarId, params, opts) {
      const body: Record<string, unknown> = {
        summary: params.summary,
        start: params.start,
        end: params.end,
      };
      if (params.description !== undefined) body['description'] = params.description;
      if (params.location !== undefined) body['location'] = params.location;
      if (params.attendees !== undefined) body['attendees'] = params.attendees;
      const query: Record<string, string> = {};
      if (params.sendUpdates !== undefined) query['sendUpdates'] = params.sendUpdates;
      const data = await makeRequest<unknown>(
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          method: 'POST',
          body,
          query,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(calendarEventSchema, data, opts?.validate);
    },
  };
}
