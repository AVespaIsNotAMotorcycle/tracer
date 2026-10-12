import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Forward API calls to the Express server during development. Keep the browser's Host
    // header (changeOrigin: false; the string shorthand sets it to true): the auth routes
    // refuse POSTs whose Origin doesn't match Host, as a cross-site check.
    proxy: {
      '/api': { target: 'http://localhost:5000', changeOrigin: false },
    },
  },
});
