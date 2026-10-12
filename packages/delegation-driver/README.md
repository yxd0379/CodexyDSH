# @codexydsh/delegation-driver

Shared in-process subagent run driver: drives a child agent on ctx.agents (used by the spawn and fork backends).

Structured runs register their capture tool and trailing instruction through the product tool and prompt services. The original DSH execution pipeline commits capture only after the authoritative result succeeds; nested program capture also waits for its outer execution.

Installed through the product bundles and profiles; DSH remains the unmodified platform dependency.

Exports: `.`.

Product dependencies: `@codexydsh/bridges`, `@codexydsh/runtime`.

Build and focused behavior tests are run from the repository root. See [product setup](../../README.md) and [component validation](../../README.md#组件清单与验证范围).
