import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { superProductivityPlugin } from '@chronoflow-desktop/vite-plugin';

export default defineConfig({
  base: './',
  plugins: [solidPlugin(), superProductivityPlugin()],
});
