import { describe, expect, it } from 'vitest'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import { remoteRuntimeEntries } from '../src/client/runtime.tsx'

describe('remote Client composition', () => {
  it('uses Loader dependencies while leaving Connection, layout, sidebar, and workspace browsing to the shell', () => {
    const ids = remoteRuntimeEntries({ manifest: {
      modules: [
        { id: '@deepseek-ai/dsh-client-ui-renderer', inject: [] },
        { id: '@codexydsh/ui-conversation', inject: ['conversation-dependency', '@deepseek-ai/dsh-client-ui-workspace'] },
        { id: 'conversation-dependency', inject: ['@deepseek-ai/dsh-client-connection'] },
        { id: '@deepseek-ai/dsh-client-connection', inject: [] },
        { id: '@deepseek-ai/dsh-client-ui-workspace', inject: [] },
        { id: '@deepseek-ai/dsh-client-ui-reference', inject: ['@codexydsh/ui-conversation'] },
      ],
      plugins: [
        { id: '@deepseek-ai/dsh-client-ui-renderer' },
        { id: '@deepseek-ai/dsh-client-connection' },
        { id: 'conversation-dependency' },
        { id: '@deepseek-ai/dsh-client-ui-workspace' },
        { id: '@codexydsh/ui-conversation' },
        { id: '@deepseek-ai/dsh-client-ui-reference' },
      ],
    } } as unknown as Pick<ClientModuleLoader, 'manifest'>)

    expect(ids).toEqual([
      '@deepseek-ai/dsh-client-ui-renderer',
      'conversation-dependency',
      '@codexydsh/ui-conversation',
      '@deepseek-ai/dsh-client-ui-reference',
    ])
  })
})
