/**
 * Shared provider/model defaults for Forge sub-agents.
 *
 * Keep these values in one place so runtime behavior, workflow metadata,
 * pricing, settings, and tests do not drift.
 */

export type PrimaryProvider = 'anthropic' | 'openai';

export const DEFAULT_PRIMARY_PROVIDER: PrimaryProvider = 'openai';

export const DEFAULT_OPENAI_PRIMARY_MODEL = 'gpt-5.5';
export const DEFAULT_OPENAI_FALLBACK_MODEL = 'gpt-5.4-mini';

export const DEFAULT_ANTHROPIC_PRIMARY_MODEL = 'claude-opus-4-7';
export const DEFAULT_ANTHROPIC_FALLBACK_MODEL = DEFAULT_OPENAI_FALLBACK_MODEL;

export function resolvePrimaryProvider(explicit?: PrimaryProvider): PrimaryProvider {
  if (explicit !== undefined) return explicit;
  if (typeof process !== 'undefined' && process.env['FORGE_PRIMARY_PROVIDER'] === 'anthropic') {
    return 'anthropic';
  }
  return DEFAULT_PRIMARY_PROVIDER;
}

export function defaultPrimaryModelForProvider(provider: PrimaryProvider): string {
  return provider === 'openai' ? DEFAULT_OPENAI_PRIMARY_MODEL : DEFAULT_ANTHROPIC_PRIMARY_MODEL;
}

export function defaultFallbackModelForProvider(provider: PrimaryProvider): string {
  return provider === 'openai' ? DEFAULT_OPENAI_FALLBACK_MODEL : DEFAULT_ANTHROPIC_FALLBACK_MODEL;
}
