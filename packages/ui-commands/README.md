# @codexydsh/ui-commands

Owns slash-command completion and popup decorations, including leading `!` shell input when the Host exposes `/shell`. Host commands remain the single execution path.

The product profile stores input preferences under `codexy-ui-commands`. Localized permission, MCP, rename, and recap tokens resolve the definitions registered by the corresponding product providers.

Enable this product plugin instead of the corresponding stock UI plugin. The fixed DSH 0.2.1-alpha.2 connection, Session, locale, layout, and slot services remain the framework providers. Browser entries are discovered through `dsh.client`.

Source adapted from DeepSeek Harness under the MIT license.
