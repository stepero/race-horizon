// Spustí naraz Vite (klient, :5173) a online server (:8787). Ctrl+C ukončí oboje.
import { spawn } from 'node:child_process';

const run = (name, args) => {
  const p = spawn('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  p.on('exit', (code) => { console.log(`[${name}] skončil (${code})`); shutdown(); });
  return p;
};
const procs = [run('server', ['vite-node', 'server/main.ts']), run('klient', ['vite'])];
let down = false;
function shutdown() {
  if (down) return;
  down = true;
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
