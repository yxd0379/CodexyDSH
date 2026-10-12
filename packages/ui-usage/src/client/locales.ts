/** Locale-owned Usage settings copy and number formatting. */

/** Usage settings dictionary namespace. */
export const NS = 'settings.usage'

/** Simplified Chinese dictionary and canonical keys. */
export const zh = {
  nav: 'Usage', description: '当前 Codexful 已保留会话的模型用量，包含重试和子代理请求',
  range: '时间范围', week: '最近 7 天', month: '最近 30 天', all: '全部时间',
  refresh: '刷新', loading: '加载用量统计', failed: '无法加载用量统计，请重试', retry: '重试',
  requests: '请求数', input: '输入 token', output: '输出 token', total: '总 token',
  models: '按模型统计', model: '模型', cached: '缓存读取',
  empty: '这个时间范围内还没有模型请求', unknown: '未知模型', unknownProvider: '未知提供方',
  missing: '{count} 个请求未返回 token 用量，已计入请求数',
  note: '输入 token 包含缓存读取和写入；输出 token 包含推理用量。仅统计已结束的请求，未返回的 token 用量不作估算',
  updated: '更新于 {time}', numberLocale: 'zh-CN',
} as const

/** Accepted Usage dictionary keys. */
export type UsageKey = keyof typeof zh

/** English dictionary with the same keys. */
export const en: Record<UsageKey, string> = {
  nav: 'Usage', description: 'Model usage from retained Codexful Sessions, including retries and subagent requests.',
  range: 'Time range', week: 'Last 7 days', month: 'Last 30 days', all: 'All time',
  refresh: 'Refresh', loading: 'Loading usage', failed: 'Could not load usage. Try again.', retry: 'Retry',
  requests: 'Requests', input: 'Input tokens', output: 'Output tokens', total: 'Total tokens',
  models: 'Usage by model', model: 'Model', cached: 'Cache reads',
  empty: 'No model requests in this time range.', unknown: 'Unknown model', unknownProvider: 'Unknown provider',
  missing: '{count} requests reported no token usage and are included in the request count.',
  note: 'Input includes cache reads and writes; output includes reasoning. Only settled requests are counted. Unreported tokens are not estimated.',
  updated: 'Updated {time}', numberLocale: 'en-US',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Usage settings copy. */
    'settings.usage': UsageKey
  }
}
