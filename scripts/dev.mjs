import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { binary, backendEnvironment } from './backend.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const children = [
  spawn(binary, [], { cwd: root, stdio: 'inherit', env: { ...backendEnvironment(), PORT: '3001', HOST: '127.0.0.1' }, windowsHide: true }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: root, stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; process.exitCode = code; children.forEach(c => c.kill()); setTimeout(() => process.exit(code), 200).unref(); }
children.forEach(c => c.on('exit', code => stop(code || 0)));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
