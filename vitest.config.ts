import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths';
import dynamicImport from 'vite-plugin-dynamic-import';

export default defineConfig(() => {
  return {
    plugins: [
      tsconfigPaths(),
      dynamicImport(),
    ],
    test: {
      include: ['**/examples/**/*.test.ts'],
    },
  };
});
