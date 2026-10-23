import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    "index": "lib/types/index.js",
    "ports": "lib/types/ports.js",
    "llm": "lib/types/llm.js",
    "tools": "lib/types/tools.js",
    "prompt": "lib/types/prompt.js",
    "session": "lib/types/session.js",
    "agent-api": "lib/types/agent-api.js",
    "types": "lib/types/types.js",
    "events": "lib/types/events.js",
    "persistence": "lib/types/persistence.js",
    "runtime-context": "lib/types/loop/runtime-context.js"
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
