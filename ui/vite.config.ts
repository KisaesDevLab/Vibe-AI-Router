import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8221, // suite block 8220–8229
    proxy: {
      '/admin-api': 'http://localhost:8220',
      '/v1': 'http://localhost:8220',
    },
  },
  build: { outDir: 'dist' },
});
