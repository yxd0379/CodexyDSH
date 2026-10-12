/** Recorded edit fragments for a mixed Host-summary and tool-metadata review. */
export const recordedChangesFixture = [
  { path: 'src/long.ts', oldText: null, newText: Array.from({ length: 120 }, (_, index) => `export const line${index} = ${index}`).join('\n') },
  { path: 'src/other.ts', oldText: 'const value = 1\n', newText: 'const value = 2\n' },
]

/** Later edit to the same file keeps an independent inspection identity. */
export const laterRecordedChangeFixture = [
  { path: 'src/long.ts', oldText: 'export const line119 = 119', newText: 'export const line119 = 120' },
]
