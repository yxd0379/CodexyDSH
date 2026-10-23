# @codexydsh/prompt-registry

Owns the product's ordered prompt sections, dynamic context, variables, and native tool schemas. It captures published DSH prompt contributions through `systemPrompt.assemble`, then combines them with product sections without modifying the platform registry.

One preparation token retains variables and the platform's direct tool presentation for the whole request. Native tool providers preserve composite execution by declaring `nestedSchemas`; assembly returns these separately from the tools sent directly to the model. Complete product prompts and scoped context suppression remain authoritative after the cooperative assembly waterfall.

When the optional public working-directory service is available, preparation captures its current directory immediately after the stock prompt assembly has ensured it. The request keeps this captured cwd through asynchronous preparation; later changes apply to the next preparation. Codexful maps the ordinary stock directory context into its existing durable environment snapshot, while unrecognized or additional context remains intact. Older compositions without this service keep their original header-based fallback.

Installed through the product bundles and profiles; DSH remains the unmodified platform dependency.

Exports: `.`.

Product dependencies: `@codexydsh/runtime`.

Build and focused behavior tests are run from the repository root. See [product setup](../../README.md) and [component validation](../../README.md#组件清单与验证范围).
