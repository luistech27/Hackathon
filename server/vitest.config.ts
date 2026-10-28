import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      // index.ts only wires the server together; it is checked by starting it, not by unit tests
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 }
    }
  }
})
