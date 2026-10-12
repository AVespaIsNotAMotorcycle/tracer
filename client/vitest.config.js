import { defineProject, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig,
  defineProject({
    test: {
      name: 'client',
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.js'],
    },
  }),
);
