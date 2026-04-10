import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client.ts',
    server: 'src/server.ts',
    'adapters/drizzle': 'src/adapters/drizzle.ts',
    'adapters/memory': 'src/adapters/memory.ts',
    test: 'src/test.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  splitting: false,
  target: 'es2022',
  outDir: 'dist',
  external: [
    'drizzle-orm',
    'pg',
    '@electric-sql/pglite',
    'better-sqlite3',
    'next',
    'hono',
    'express',
    'react',
    'ink',
  ],
})
