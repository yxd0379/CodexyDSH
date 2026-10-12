# @codexydsh/filesystem-sandbox

Sandbox-enforcing implementation of the DeepSeek Harness filesystem seam: fences write/edit by the per-call sandbox mode (read-only denies mutation, workspace-write contains it to the workspace + temp roots) while reads pass through.

Installed through the product bundles and profiles; DSH remains the unmodified platform dependency.

Exports: `.`.

Build and focused behavior tests are run from the repository root. See [product setup](../../README.md) and [component validation](../../README.md#组件清单与验证范围).
