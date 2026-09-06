import { defineConfig } from 'tsup';
import { version } from './package.json';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node20',
  splitting: false,
  define: { __VERSION__: JSON.stringify(version) },
});
