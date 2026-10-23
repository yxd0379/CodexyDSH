import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    "index": "lib/types/index.js",
    "client": "lib/types/client.js",
    "estimate": "lib/types/estimate.js"
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
