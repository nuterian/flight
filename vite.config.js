import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev` serves plain http on localhost.
// `npm run dev:mobile` serves https on your LAN so phones can use motion sensors.
// Production builds are served from https://nuterian.github.io/flight/, hence the base path.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/flight/' : '/',
  plugins: process.env.MOBILE ? [basicSsl()] : [],
  server: { host: process.env.MOBILE ? true : 'localhost' },
  build: { target: 'esnext' },
}));
