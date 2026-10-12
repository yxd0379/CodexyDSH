/** Artifact checks run explicitly after a complete product build. */
import { defineConfig } from 'vitest/config'
import source from './vitest.config.ts'

export default defineConfig({ ...source, test: { ...source.test,
  include: ['tests/**/*.artifact.{client,host}.spec.ts'], exclude: [],
} })
