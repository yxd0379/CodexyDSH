# @codexydsh/skill-filesystem

Local filesystem skill provider for the DeepSeek Harness.

Directory skills can set `policy.allow_implicit_invocation: false` in `agents/openai.yaml` to stay out of the model's automatic skill catalog while remaining available to an explicit user invocation. Missing policy defaults to implicit use; existing `SKILL.md` invocation restrictions still apply. Flat Markdown skills do not inherit a parent-directory sidecar.

Installed through the product bundles and profiles; DSH remains the unmodified platform dependency.

Exports: `.`.

Product dependencies: `@codexydsh/filesystem`.

Build and focused behavior tests are run from the repository root. See [product setup](../../README.md) and [component validation](../../README.md#组件清单与验证范围).
