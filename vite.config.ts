import { defineConfig, type Plugin } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { build } from 'esbuild';
import manifest from './manifest.json';
import { resolve } from 'path';

/**
 * Compile src/inject/downloader.ts → public/inject/downloader.js
 * during buildStart so CRXJS can find it as a web_accessible_resource.
 *
 * CRXJS doesn't process .ts files in web_accessible_resources,
 * so we pre-compile with esbuild into the public/ dir.
 */
function compileInjectScript(): Plugin {
  return {
    name: 'compile-inject-script',
    async buildStart() {
      await build({
        entryPoints: [resolve(__dirname, 'src/inject/downloader.ts')],
        outfile: resolve(__dirname, 'public/inject/downloader.js'),
        bundle: true,
        format: 'iife',
        target: 'chrome120',
        minify: false,
      });
    },
  };
}

export default defineConfig({
  plugins: [
    compileInjectScript(),
    crx({ manifest }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
      },
    },
  },
});
