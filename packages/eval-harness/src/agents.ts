/**
 * The four sub-agents we evaluate. Order matters only for human-readable
 * reports — runner.ts iterates this list and produces output in the same
 * order so diff output is stable.
 */
export const AGENT_NAMES = ['schema-smith', 'tool-coder', 'inspector', 'shipper'] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

/**
 * Resolve the on-disk path of a Promptfoo config for an agent. Centralized
 * so both runner + validator agree on the layout. Layout:
 *
 *     packages/eval-harness/evals/<agent>.yaml
 */
export function agentConfigPath(agent: AgentName, repoRelativeRoot: string): string {
  return `${repoRelativeRoot}/evals/${agent}.yaml`;
}
