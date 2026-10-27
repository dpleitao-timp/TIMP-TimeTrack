import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
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
        orientation: 'landscape',
        background_color: '#0b1220',
        theme_color: '#0b1220',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
    }),
  ],
  build: { chunkSizeWarningLimit: 2500 },
})
