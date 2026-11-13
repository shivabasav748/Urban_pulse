import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// base matches the GitHub Pages repo path; harmless locally
export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/Urban_pulse/' : '/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { globals: true, environment: 'node', exclude: ['e2e/**', 'node_modules/**'] },
})
