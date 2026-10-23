# Product test fixtures

The private `@codexydsh/test-support` package supplies deterministic Session, workspace, Remote, configuration, and locale fixtures for CodexyDSH feature tests. Slot tests install the public DSH renderer and Session services; they do not copy their private implementations. Namespace calls fail unless a test scripts them explicitly.

Common translations are read from the fixed published locale artifact. The test-only browser factory adapter executes published ModuleLoader factories as ESM; production continues to use the upstream loader. DOM geometry suites can override the default initial ResizeObserver delivery.

Fixtures use public platform imports and never load the original development repository. This package is excluded from product publication.
