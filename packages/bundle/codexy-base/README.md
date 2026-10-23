# CodexyDSH base

The base bundle selects the Codexy agent loop, model adapters, tools, approval, and compaction while retaining the shared Harness Session and storage services. Web and headless profiles use this same runtime.

Shared native providers supply `/compact`, plan mode, web search/fetch, and `ask_user_question`; the compact command calls the Codexy compaction implementation through `ctx.compaction`.

Session files use the Harness format beneath the product home. The legacy Codexy artifact provider and remote deployment are not mounted.
