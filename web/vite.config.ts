import { defineConfig } from 'vite';

// `npm run dev` serves the app locally and forwards /api to the deployed stack.
// Set VTT_SITE_URL to the stack's SiteUrl output, e.g. VTT_SITE_URL=https://dxxxx.cloudfront.net
export default defineConfig({
  server: {
    proxy: process.env.VTT_SITE_URL ? { '/api': { target: process.env.VTT_SITE_URL, changeOrigin: true } } : undefined,
  },
});
