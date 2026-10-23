import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    "index": "lib/types/index.js",
    "model-selection-settings": "lib/types/model-selection-settings.js",
    "codexful-v2": "lib/types/codexful-v2.js",
    "codex-v1": "lib/types/codex-v1.js"
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
