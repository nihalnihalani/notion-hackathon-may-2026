import type { PrimaryProvider } from '@forge/agents';

import type { GenerationRequestedEvent, WorkflowConfig } from './types.js';

const QUEUED_MODEL_PROVIDERS: Readonly<Record<string, PrimaryProvider>> = {
  'gpt-5.5': 'openai',
  'gpt-5.4-mini': 'openai',
  'claude-opus-4-7': 'anthropic',
};

/**
 * Apply the workspace default model captured when a generation was queued.
 *
 * `auto` intentionally returns the original object so deploy-time defaults
 * and `FORGE_PRIMARY_PROVIDER` keep working. Concrete model ids override the
 * primary provider/model only for this run.
 */
export function applyQueuedDefaultModel(
  config: WorkflowConfig,
  event: Pick<GenerationRequestedEvent, 'defaultModel'>,
): WorkflowConfig {
  const model = normalizeQueuedModel(event.defaultModel);
  if (model === null) return config;
  const provider = QUEUED_MODEL_PROVIDERS[model];
  if (provider === undefined) return config;

  return {
    ...config,
    subAgent: {
      ...config.subAgent,
      primaryProvider: provider,
      primaryModel: model,
    },
  };
}

function normalizeQueuedModel(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === 'auto') return null;
  return trimmed;
}
