# @codexydsh/ui-chat

Owns the CodexyDSH transcript, work details, prompt optimization, timing and token displays, code and tool cards, transcript preferences, and history page size. It consumes the upstream Session service through the product event projection.

The product profile stores its preferences under the `codexy-ui-chat` entry.

Enable this product plugin instead of the corresponding stock UI plugin. The fixed DSH 0.2.1-alpha.2 connection, Session, locale, layout, and slot services remain the framework providers. Browser entries are discovered through `dsh.client`.

Source adapted from DeepSeek Harness under the MIT license.
