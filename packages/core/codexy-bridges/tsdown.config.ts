import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    "index": "lib/types/index.js",
    "tools": "lib/types/tools.js",
    "tool-port": "lib/types/tool-port.js",
    "session-reads": "lib/types/session-reads.js"
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
