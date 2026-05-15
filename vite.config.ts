// Autor:   María León Pérez
// Resumen: Configuración de Vite (bundler del frontend). Registra los plugins de React
//          y Tailwind CSS v4. El alias '@' apunta a la raíz del proyecto para importaciones
//          absolutas. HMR (Hot Module Replacement) puede desactivarse en entornos de
//          edición automática mediante la variable de entorno DISABLE_HMR=true.
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
