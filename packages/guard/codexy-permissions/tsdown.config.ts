import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    "index": "lib/types/index.js",
    "types": "lib/types/types.js",
    "client": "lib/types/client.js"
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
