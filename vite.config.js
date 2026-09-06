import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev` serves plain http on localhost.
// `npm run dev:mobile` serves https on your LAN so phones can use motion sensors.
export default defineConfig({
  plugins: process.env.MOBILE ? [basicSsl()] : [],
  server: { host: process.env.MOBILE ? true : 'localhost' },
  build: { target: 'esnext' },
});
