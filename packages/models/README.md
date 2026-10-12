# @codexydsh/models

Multi-provider model routes with Codexy native tools, immutable request generations and durable protocol replay.

Installed through the product bundles and profiles; DSH remains the unmodified platform dependency.

The product pins pi-ai 0.85.1 and maintains [one SDK patch](../../patches/pi-ai-0.85.1.patch) for lossless custom tool inputs, malformed function arguments, response continuation flags, stable history identities and end-only argument parsing. Build and profile installation both apply this patch; DSH packages remain unmodified.

Exports: `.`.

An explicit provider profile `backendHostedTools: ['web_search']` enables native
OpenAI Responses hosted search over `api: 'openai-responses'` and SSE (optional
`transport: 'sse'`). Omission or an empty list leaves the existing route unchanged.
The server, not this plugin, executes the search. Native `web_search_call` items,
progress, output ordering, and original JSON are retained for same-route history
and recovery. Unfinished added items/progress remain explicit attempt recovery
facts, not completed model history. Compaction keeps native history without
adding a hosted tool declaration. They are not dispatched as local functions. Existing local web
tools are not removed or renamed by this option. Different/non-hosted routes
report replay degradation and retain the original durable facts rather than
fabricating search results. Synthetic lifecycle tests demonstrate the adapter;
they do not qualify any live backend, including the current Qwen/vLLM service.

Build and focused behavior tests are run from the repository root. See [product setup](../../README.md) and [component validation](../../README.md#组件清单与验证范围).
