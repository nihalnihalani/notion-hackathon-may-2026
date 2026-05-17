import { ImageResponse } from 'next/og';

export const SOCIAL_IMAGE_ALT =
  'Forge — describe an agent, ship a deployed Notion Custom Agent in 90 seconds';
export const SOCIAL_IMAGE_SIZE = { width: 1200, height: 630 } as const;
export const SOCIAL_IMAGE_CONTENT_TYPE = 'image/png';

// Forge brand palette mirrors --forge-primary (263deg 70% 55%) and
// --forge-accent (326deg 80% 60%) from app/globals.css. Hand-converted to
// hex because Satori's CSS-in-JS doesn't resolve CSS custom properties.
const COLOR_BG = '#0b0815';
const COLOR_PRIMARY = '#7c3aed';
const COLOR_ACCENT = '#ec4899';
const COLOR_TEXT = '#f8fafc';
const COLOR_MUTED = '#cbd5e1';

export function renderSocialImage(): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: COLOR_BG,
          backgroundImage: `radial-gradient(circle at 20% 20%, ${COLOR_PRIMARY}33 0%, transparent 55%), radial-gradient(circle at 85% 85%, ${COLOR_ACCENT}33 0%, transparent 55%)`,
          padding: '72px 80px',
          color: COLOR_TEXT,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `linear-gradient(135deg, ${COLOR_PRIMARY} 0%, ${COLOR_ACCENT} 100%)`,
              boxShadow: `0 10px 40px ${COLOR_PRIMARY}55`,
            }}
          >
            <svg
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
              <path d="M20 3v4" />
              <path d="M22 5h-4" />
              <path d="M4 17v2" />
              <path d="M5 18H3" />
            </svg>
          </div>
          <span
            style={{
              fontSize: 52,
              fontWeight: 700,
              letterSpacing: 0,
            }}
          >
            Forge
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
            marginTop: 'auto',
          }}
        >
          <div
            style={{
              fontSize: 84,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: 0,
              maxWidth: 980,
            }}
          >
            Notion Custom Agent Studio
          </div>
          <div
            style={{
              fontSize: 32,
              lineHeight: 1.35,
              color: COLOR_MUTED,
              maxWidth: 980,
            }}
          >
            Describe an agent in plain English. Forge ships a real, deployed Notion Custom Agent in
            90 seconds.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 56,
          }}
        >
          <div
            style={{
              height: 6,
              width: 220,
              borderRadius: 999,
              background: `linear-gradient(90deg, ${COLOR_PRIMARY} 0%, ${COLOR_ACCENT} 100%)`,
            }}
          />
          <span
            style={{
              fontSize: 24,
              color: COLOR_MUTED,
              letterSpacing: 0,
            }}
          >
            Notion Custom Agent Studio
          </span>
        </div>
      </div>
    ),
    { ...SOCIAL_IMAGE_SIZE },
  );
}
