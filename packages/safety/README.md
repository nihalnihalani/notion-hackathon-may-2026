# @forge/safety

The code-gen safety net. AST-walks every generated TypeScript file against a forbidden-API list (no `eval`, no `child_process`, no raw network beyond approved connectors, no `fs` writes outside the worker's scratch dir), validates `j` schemas against a strict reference, and enforces secret-handling rules so secrets never appear in source.

## Public API surface

- TBD
