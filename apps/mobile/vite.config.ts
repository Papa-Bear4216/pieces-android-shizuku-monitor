import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { resolve } from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'mem0ai/oss': resolve(__dirname, 'src/lib/mem0.ts'),
    },
  },
})
