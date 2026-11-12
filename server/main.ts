import { DEFAULT_PORT } from '../src/net/protocol';
import { startServer } from './index';

const port = Number(process.env.PORT) || DEFAULT_PORT;
startServer(port).then((s) => {
  console.log(`Race Horizon server beží na ws://localhost:${s.port}  (kontrola: http://localhost:${s.port}/health)`);
}).catch((e) => {
  console.error('Server sa nepodarilo spustiť:', e instanceof Error ? e.message : e);
  process.exit(1);
});
