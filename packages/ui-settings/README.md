# @codexydsh/ui-settings

Adapts DSH 0.2.1-alpha.2's public settings validator to accept frozen mirror values. Schemastery normalizes dictionary entries during validation; this plugin passes it a detached draft and restores the original validator on disposal. The public settings mirror, configuration forms, revision checks, and writes remain their existing providers.

MCP and Remote settings require `codexySettingsSchema` so this plugin activates before their forms are created. The Web product bundle includes it once.
