import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Versão mostrada no canto inferior direito: versão do package.json, commit (com "+" se houver alterações por
// commitar) e data da compilação (dd/mm/yyyy). Serve para confirmar que o tablet tem a versão certa.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))
const git = (cmd) => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}
const commit = git('git rev-parse --short HEAD') || 'dev'
const dirty = git('git status --porcelain') ? '+' : ''
const d = new Date()
const buildDate = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD__: JSON.stringify(`${commit}${dirty}`),
    __APP_DATE__: JSON.stringify(buildDate),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['timp-logo.png'],
      workbox: {
        // modelos de reconhecimento têm de ficar em cache para funcionar offline
        globPatterns: ['**/*.{js,css,html,svg,json,bin}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: '/index.html',
      },
      manifest: {
        name: 'TIMP Relógio de Ponto',
        short_name: 'Ponto',
        description: 'Picagem por reconhecimento facial (mockup)',
        display: 'fullscreen',
        orientation: 'any', // acompanha o aparelho: tablet fixo (deitado ou em pé) e telemóvel em pé
        background_color: '#f4f5f7',
        theme_color: '#7e0406',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  build: { chunkSizeWarningLimit: 2500 },
})
