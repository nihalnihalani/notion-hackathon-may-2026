import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';

import { requireUser } from '@/lib/auth';
import { buildNotionAuthorizeUrl, NOTION_OAUTH_STATE_COOKIE } from '@/lib/notion-oauth';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSentry(
  async () => {
    const r = await requireUser();
    if (!r.ok) return r.response;

    const state = randomBytes(32).toString('base64url');
    const authorizeUrl = buildNotionAuthorizeUrl(state);
    const response = NextResponse.redirect(authorizeUrl, { status: 303 });
    response.cookies.set(NOTION_OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      maxAge: 10 * 60,
      path: '/',
      sameSite: 'lax',
      secure:
        authorizeUrl.protocol === 'https:' &&
        process.env['NEXT_PUBLIC_APP_URL']?.startsWith('https://'),
    });
    return response;
  },
  { routeName: 'auth.notion.start' },
);
