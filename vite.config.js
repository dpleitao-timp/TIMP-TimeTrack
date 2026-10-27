import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
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
        orientation: 'landscape',
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
