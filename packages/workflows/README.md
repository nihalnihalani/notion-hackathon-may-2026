# @forge/workflows

The Vercel Workflow DevKit DAG that orchestrates a Forge generation: Schema Smith → Tool Coder → (loop: Inspector → Tool Coder retry) → Shipper. Owns step-level retry policy, cancellation, idempotency keys, and durable state checkpoints so an in-flight generation survives a deploy.

## Public API surface

- `runForgeGeneration(event, config)` — plain async workflow body used by the
  Vercel Workflow adapter and tests.
- `FORGE_WORKFLOW_NAME`, `FORGE_GENERATION_CONCURRENCY_LIMIT`,
  `FORGE_CANCELLATION_EVENT` — deployment/runtime constants.
- `publishGenerationRequested(payload, options?)` — enqueue a generation run.
- `publishGenerationCancelled(generationId, reason, options)` and
  `cancelInflight(...)` — cancellation publisher seams.
- `createForgeInngestFunctions(...)` — optional Inngest backup workflow.
- `sumGenerationCost`, `sumGenerationLatency`, `costExceedsBudget` — pure
  accounting helpers shared with the dashboard.
- Types: `GenerationRequestedEvent`, `GenerationCancelledEvent`,
  `WorkflowConfig`, and `WorkflowSuccess`.
