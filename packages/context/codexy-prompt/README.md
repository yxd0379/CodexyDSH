# @codexydsh/prompt

Codex-derived coding prompt and runtime environment for the Codexful application.

Installed through the product bundles and profiles; DSH remains the unmodified platform dependency.

`strictModelInput` is the legacy name for preferring pinned Codex input
serialization, not a whitelist that rejects other product capabilities. Extra
tools and contexts remain visible; permission templates fall back to the actual
DSH policy. The public effective working directory is captured per preparation
and retained in the existing durable environment facts. Independent evaluation
reports request differences instead of preventing normal product execution.

Exports: `.`, `./recap`.

Product dependencies: `@codexydsh/bridges`, `@codexydsh/compaction`, `@codexydsh/retry`, `@codexydsh/delegation`, `@codexydsh/prompt-registry`.

Build and focused behavior tests are run from the repository root. See [product setup](../../README.md) and [component validation](../../README.md#组件清单与验证范围).
