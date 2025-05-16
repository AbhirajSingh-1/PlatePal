// frontend/vite.config.js

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '../backend/client'), // 👈 this puts your built files inside backend/client
    emptyOutDir: true
  }
})
