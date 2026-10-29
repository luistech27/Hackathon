import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'], // Playwright's, run with npm run e2e
    // Every test file starts its own in-memory Postgres (PGlite); with many files in parallel,
    // and coverage on, starting one can take well over the default 10 s.
    hookTimeout: 60_000,
    coverage: {
      include: ['src/**/*.ts'],
      // index.ts only wires the server together; it is checked by starting it, not by unit tests
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 }
    }
  }
})
