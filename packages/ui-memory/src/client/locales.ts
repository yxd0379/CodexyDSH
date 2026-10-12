/** Locale-owned memory browsing, editing, and refresh copy. */

/** Dictionary namespace owned by the memory dialog. */
export const NS = 'memory'

/** Simplified Chinese dictionary and canonical key set. */
export const zh = {
  session: '整理记忆使用的会话', noSession: '先创建一个会话，再查看或整理记忆',
  title: '记忆', description: '查看长期记忆、编辑摘要和索引，或用当前会话的模型重新整理',
  close: '关闭', refresh: '整理记忆', refreshRunning: '正在整理', reload: '重新加载',
  root: '存储位置', version: '版本', summary: '摘要', files: '文档',
  empty: '还没有长期记忆。整理记忆会从已有会话中提取有用信息',
  emptyDirectory: '此目录为空', search: '搜索', searchPlaceholder: '搜索记忆内容',
  noMatches: '没有找到匹配内容', more: '加载更多', up: '上一级',
  choose: '选择文档查看详情', edit: '编辑', save: '保存', discard: '放弃修改',
  readonly: '此文档只读', truncated: '内容已截断，不能用此片段覆盖完整文档',
  editDescription: '仅摘要和 MEMORY.md 可编辑。保存前会保留原文，并校验文档版本',
  conflict: '文档已经变化，草稿已保留。复制草稿后放弃修改，再重新读取文档',
  requestFailed: '操作失败，已保留当前内容和草稿', unsaved: '请先保存或放弃当前修改',
  savedReadFailed: '保存已成功，但无法重新读取文档。草稿已保留，请核对已保存的内容',
  loading: '正在加载记忆', saved: '记忆已保存', refreshed: '记忆整理完成：提取 {count} 个会话',
  refreshEmpty: '没有可提取的旧会话，已有记忆保持不变',
  running: '后台正在整理记忆', previousError: '上次整理未完成',
  editorLabel: '记忆文档内容', searchResults: '搜索结果', line: '第 {line} 行',
} as const

/** English dictionary with the same key set. */
export const en: Record<MemoryKey, string> = {
  session: 'Session used to refresh memory', noSession: 'Create a Session to browse or refresh memory.',
  title: 'Memory', description: 'Browse long-term memory, edit the summary and index, or refresh using this Session’s model.',
  close: 'Close', refresh: 'Refresh memory', refreshRunning: 'Refreshing', reload: 'Reload',
  root: 'Storage', version: 'Version', summary: 'Summary', files: 'Documents',
  empty: 'No long-term memory yet. Refresh memory to extract useful information from existing Sessions.',
  emptyDirectory: 'This directory is empty', search: 'Search', searchPlaceholder: 'Search memory content',
  noMatches: 'No matches found', more: 'Load more', up: 'Parent directory',
  choose: 'Select a document to read its details', edit: 'Edit', save: 'Save', discard: 'Discard changes',
  readonly: 'This document is read-only', truncated: 'This content is truncated and cannot overwrite the complete document.',
  editDescription: 'Only the summary and MEMORY.md are editable. Saving preserves the original and checks the document revision.',
  conflict: 'The document changed. Your draft is preserved. Copy it before discarding changes and reading the document again.',
  requestFailed: 'The operation failed. Current content and your draft are preserved.', unsaved: 'Save or discard the current changes first.',
  savedReadFailed: 'Saving succeeded, but the stored document could not be read again. Your draft is preserved for verification.',
  loading: 'Loading memory', saved: 'Memory saved', refreshed: 'Memory refreshed: {count} Sessions extracted',
  refreshEmpty: 'No eligible old Sessions. Existing memory is unchanged.',
  running: 'Memory is being refreshed in the background', previousError: 'The previous refresh did not finish',
  editorLabel: 'Memory document content', searchResults: 'Search results', line: 'Line {line}',
}

/** Dictionary keys accepted by the memory surface. */
export type MemoryKey = keyof typeof zh
