/** Product behavior tests run against the fixed public DSH packages. */
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { paths, root } from './scripts/configure.mjs'
import { standardDecorators } from './scripts/test-decorators.ts'
import { platformClientFactories } from './scripts/test-client-closures.ts'

export default defineConfig({
  plugins: [platformClientFactories(), standardDecorators()],
  resolve: { preserveSymlinks: true, alias: [{ find: /^@codexydsh\/([^/]+)\/src\/(.+)$/, replacement: `${root}/packages/$1/src/$2` }, ...Object.entries(paths).map(([name, [source]]) => ({ find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: fileURLToPath(new URL(source, `file://${root}/`)) }))] },
  test: { include: ['packages/*/tests/**/*.spec.{ts,tsx}', 'tests/**/*.spec.{ts,tsx}'],
    exclude: ['**/*.artifact.{client,host}.spec.ts'],
    server: { deps: { inline: [/@deepseek-ai[\/]/] } },
    setupFiles: ['./scripts/test-dom-environment.ts'],
    environment: 'node', environmentMatchGlobs: [['**/*.client.spec.{ts,tsx}', 'jsdom']],
    pool: 'forks', maxWorkers: 4, testTimeout: 20000, hookTimeout: 20000,
  },
})
