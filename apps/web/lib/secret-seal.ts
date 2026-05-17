import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const AAD = Buffer.from('forge:notion-oauth-token:v1', 'utf8');

function encryptionSecret(): string {
  const secret =
    process.env['FORGE_TOKEN_ENCRYPTION_SECRET'] ??
    process.env['CLERK_SECRET_KEY'] ??
    process.env['NOTION_OAUTH_CLIENT_SECRET'];
  if (!secret) {
    throw new Error(
      'FORGE_TOKEN_ENCRYPTION_SECRET, CLERK_SECRET_KEY, or NOTION_OAUTH_CLIENT_SECRET must be set to store Notion OAuth tokens.',
    );
  }
  return secret;
}

function key(): Buffer {
  return createHash('sha256').update(encryptionSecret(), 'utf8').digest();
}

export function sealSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function unsealSecret(sealed: string): string {
  const [version, ivPart, tagPart, ciphertextPart] = sealed.split(':');
  if (version !== VERSION || !ivPart || !tagPart || !ciphertextPart) {
    throw new Error('Unsupported sealed secret format.');
  }

  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivPart, 'base64url'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
