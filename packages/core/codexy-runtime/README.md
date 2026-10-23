# Codexy runtime

`@codexydsh/runtime` supplies this repository's Codexy AgentFactory. The shared base profile selects this driver once; workspace packages provide `codexyRequests`, `codexyPrompt`, and `codexyTools`. The Harness AgentRegistry, Session, persistence, and projection services remain shared infrastructure. This fork builds those packages together and does not target separately installed DSH versions.

The default driver preserves Codexy input ordering, native freeform tools, frozen provider and tool generations, early tool dispatch, completed-output recovery, and mailbox continuation. The named `AgentLoop` uses generic DSH input placement for applications that use the product request providers with other presets. `./agent` also supplies per-step model selection that binds the chosen route and reasoning effort to its preparation token. The native `codexy-llm/stream` waterfall observes captured requests; the original `llm/stream` receives a stock-compatible view while dispatch retains the captured native request.

`./types` and `./events` expose transcript types and projections without importing product Host services. `projectProductEvent` expands a required fact at its original sequence and time. `./session` provides native request headers, message derivation, event encoding, and fork recovery over the original Session API. Each request writes an unchanged native `request/header` followed by a required `codexy/fact` containing the complete product header, including freeform tools, namespaces, and Responses controls. Product readers fold that fact after the native header, so cold recovery retains the same request settings without adding fields to the native envelope. Other product-only model and recovery events use required `codexy/fact` envelopes. The Agent-scoped scheduler also uses these envelopes because its version-1 `schedule/change` payload differs from the upstream event with the same name.

Model-input and recovery facts are required. Diagnostic metadata does not grant permission to repeat a tool invocation or a model request. The runtime uses the workspace Session implementation rather than a cross-version compatibility matrix.

The selected base uses the Harness JSONL persistence provider beneath the independent product home. The retained `./persistence` implementation and legacy import helpers are not mounted; source availability does not enable a different file container or automatic migration.

Existing official DSH conversations and profiles are not opened or imported by product initialization. Legacy data conversion is outside this composition.

The runtime incorporates bounded MIT-licensed DSH driver, recovery, and relationship-validation code. See LICENSE and NOTICE.
