import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globalSetup: ['./test/helpers/global-setup.ts'], testTimeout: 30000, hookTimeout: 120000, fileParallelism: false } });
