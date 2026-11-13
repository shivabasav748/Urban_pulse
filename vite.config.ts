import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// `vite --mode https` (pnpm dev:https): development-only HTTPS so phones on the LAN can use GPS.
// Supabase is proxied at /sb so the HTTPS page never calls plain HTTP (mixed content) or the phone's own 127.0.0.1.
export default defineConfig(({ mode }) => {
  const https = mode === 'https'
  if (https && !existsSync('certs/dev.crt')) throw new Error('Run `pnpm cert:dev` first (creates certs/ for local HTTPS).')
  return {
    // base matches the GitHub Pages repo path; harmless locally
    base: process.env.GITHUB_PAGES ? '/Urban_pulse/' : '/',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: https ? {
      host: true,
      https: { key: readFileSync('certs/dev.key'), cert: readFileSync('certs/dev.crt') },
      proxy: { '/sb': { target: 'http://127.0.0.1:54321', changeOrigin: true, ws: true, rewrite: (p: string) => p.replace(/^\/sb/, '') } },
    } : undefined,
    // only our own tests: UrbanPulse_jcr/ is the design reference folder (separate app, own node_modules)
    test: { globals: true, environment: 'node', include: ['src/**/*.test.ts'] },
  }
})
