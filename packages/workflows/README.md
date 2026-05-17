# @forge/workflows

The Vercel Workflow DevKit DAG that orchestrates a Forge generation: Schema Smith → Tool Coder → (loop: Inspector → Tool Coder retry) → Shipper. Owns step-level retry policy, cancellation, idempotency keys, and durable state checkpoints so an in-flight generation survives a deploy.

## Public API surface

- TBD
