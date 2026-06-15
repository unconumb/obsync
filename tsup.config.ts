import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'cli/index': 'src/cli/index.ts' },
  format: ['cjs'],
  target: 'node20',
  clean: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
