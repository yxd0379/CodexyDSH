/** Public Session wire and projection vocabulary shared with the DSH client. */
export * from '@deepseek-ai/dsh-api-session-controller/types'

/** Native metadata carried by the product model picker. */
declare module '@deepseek-ai/dsh-api-session-controller/types' {
  interface ModelCatalogModel {
    readonly showInPicker?: boolean
    readonly multiAgentVersion?: 'disabled' | 'v1' | 'v2'
    readonly serviceTiers?: readonly string[]
  }
}
