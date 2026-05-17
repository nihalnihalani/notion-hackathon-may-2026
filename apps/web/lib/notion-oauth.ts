import { DEFAULT_NOTION_VERSION } from '@forge/notion-client';

export const NOTION_OAUTH_STATE_COOKIE = 'forge_notion_oauth_state';

export interface NotionOAuthToken {
  accessToken: string;
  workspaceId: string;
  workspaceName: string;
}

export function notionOAuthRedirectUri(): string {
  return (
    process.env['NOTION_OAUTH_REDIRECT_URI'] ??
    `${process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000'}/api/auth/notion/callback`
  );
}

export function buildNotionAuthorizeUrl(state: string): URL {
  const clientId = process.env['NOTION_OAUTH_CLIENT_ID'];
  if (!clientId) {
    throw new Error('NOTION_OAUTH_CLIENT_ID is not configured.');
  }

  const url = new URL('https://api.notion.com/v1/oauth/authorize');
  url.searchParams.set('owner', 'user');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', notionOAuthRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url;
}

export async function exchangeNotionAuthorizationCode(code: string): Promise<NotionOAuthToken> {
  const clientId = process.env['NOTION_OAUTH_CLIENT_ID'];
  const clientSecret = process.env['NOTION_OAUTH_CLIENT_SECRET'];
  if (!clientId || !clientSecret) {
    throw new Error('NOTION_OAUTH_CLIENT_ID and NOTION_OAUTH_CLIENT_SECRET must be configured.');
  }

  const response = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
      'Notion-Version': DEFAULT_NOTION_VERSION,
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: notionOAuthRedirectUri(),
    }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    workspace_id?: unknown;
    workspace_name?: unknown;
    error?: unknown;
    message?: unknown;
    code?: unknown;
  };

  if (!response.ok) {
    const detail =
      typeof body.message === 'string'
        ? body.message
        : typeof body.error === 'string'
          ? body.error
          : `HTTP ${response.status}`;
    throw new Error(`Notion OAuth token exchange failed: ${detail}`);
  }

  if (typeof body.access_token !== 'string' || typeof body.workspace_id !== 'string') {
    throw new TypeError('Notion OAuth response did not include an access token and workspace id.');
  }

  return {
    accessToken: body.access_token,
    workspaceId: body.workspace_id,
    workspaceName:
      typeof body.workspace_name === 'string' ? body.workspace_name : 'Untitled Workspace',
  };
}
