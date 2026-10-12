# @codexydsh/bridges

Provides `codexyRequests` and `codexyTools` over the published DSH provider directory and tool policy pipeline. The product loop captures model routes, native schemas, tool implementations, and prompt variables before dispatch; reloads cannot substitute a different implementation into an in-flight request.

Native request fields remain available to product adapters. Public LLM observers receive the compatible DSH projection. Tool execution retains the platform's authorization, sandbox, presentation, and result hooks, with each policy invoked once. Public prompt presentation selects direct tools; captured tools hidden behind `run_code` remain available as nested SDK bindings.

Installed through the product bundles and profiles; DSH remains the unmodified platform dependency.

Exports: `.`, `./tools`, `./tool-port`, `./session-reads`.

Product dependencies: `@codexydsh/runtime`, `@codexydsh/prompt-registry`.

Build and focused behavior tests are run from the repository root. See [product setup](../../README.md) and [component validation](../../README.md#组件清单与验证范围).
