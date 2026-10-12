# Codexy Auto Review

`@codexydsh/auto-review` uses the product request provider, approval service, and session permission state to review actions. In `codexful` mode, it preserves the standing sandbox and reviews approval requests for wider access. The reviewer can inspect files through bounded read-only investigation tools when enabled.

The `auto` mode reviews native calls and nested code-mode calls before dispatch using the logged request, action, instructions, and retained history. Missing or conflicting facts, malformed decisions, and reviewer failures reject the action. Reviewer input stays frozen through dispatch. Disposal closes admission, drains active reviews, and migrates sessions away from the unavailable Auto choice.

The product bundle selects `codexful` mode. Configuration and review records belong to the product; the released DSH tool policy pipeline remains responsible for execution. The package exports its root plugin.
