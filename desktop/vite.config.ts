import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3456',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:3456',
        ws: true,
        changeOrigin: true,
      },
      '/sdk': {
        target: 'ws://127.0.0.1:3456',
        ws: true,
        changeOrigin: true,
      },
      '/proxy': {
        target: 'http://127.0.0.1:3456',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:3456',
        changeOrigin: true,
      },
    },
  },
})
