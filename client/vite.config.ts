/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  test: {
    setupFiles: ['./src/test/setup.ts'],
    // Unit tests never touch a network: every domain uses the fixture-backed mock adapters.
    // (The development default mocks only the domains the server cannot answer yet.)
    env: { VITE_USE_MOCKS: 'all' },
  },
});
