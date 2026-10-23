# Product loop test fixtures

This private package mounts original DSH services with Codexy request, native-tool, and prompt providers. Tests mount the owned runtime after their load-order-sensitive plugins and dispose their own Cordis context.

Register model adapters through `ctx.codexyRequests`, product prompt contributions through `ctx.codexyPrompt`, and native tools through `ctx.codexyTools`. Original service registries remain available for platform contributions. This fixture does not redirect stock registrations or change platform implementations.
