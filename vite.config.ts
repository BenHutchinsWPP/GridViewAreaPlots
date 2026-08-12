import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  assetsInclude: ['**/*.wasm'],
  build: {
    target: 'ES2022'
  }
});
