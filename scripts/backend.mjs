// Build tooling only. All application API and runtime logic lives in backend/src/*.cpp.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
export const binary = process.env.DATUM_SERVER || join(root, 'build/backend', windows ? 'datum-server.exe' : 'datum-server');
export function backendEnvironment() {
  const env = { ...process.env };
  if (windows) {
    const qtRoot = process.env.QT_ROOT || ['C:/Qt', 'E:/App/Qt', 'D:/Qt'].find(existsSync);
    const version = qtRoot && readdirSync(qtRoot).filter(s => /^6\.\d+\.\d+$/.test(s)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    const prefix = process.env.CMAKE_PREFIX_PATH || (version ? join(qtRoot, version, 'mingw_64') : '');
    if (prefix) env.CMAKE_PREFIX_PATH = prefix;
    const tools = qtRoot ? join(qtRoot, 'Tools') : '';
    const compiler = process.env.MINGW_ROOT || (tools && readdirSync(tools).filter(s => /^mingw\d+_64$/.test(s)).sort((a,b) => Number(b.match(/\d+/)[0])-Number(a.match(/\d+/)[0])).map(s => join(tools, s)).find(s => existsSync(join(s, 'bin/g++.exe'))));
    const additions = [prefix && join(prefix, 'bin'), compiler && join(compiler, 'bin'), compiler && join(compiler, 'opt/bin'), tools && join(tools, 'CMake_64/bin'), tools && join(tools, 'Ninja')].filter(Boolean);
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = [...additions, env[pathKey] || ''].join(';');
    if (compiler) env.OPENSSL_ROOT_DIR ||= join(compiler, 'opt');
    if (prefix) env.QT_PLUGIN_PATH ||= join(prefix, 'plugins');
    const pdf = join(root, '.tools/poppler/poppler-24.08.0/Library/bin/pdftotext.exe');
    if (!env.PDFTOTEXT && existsSync(pdf)) env.PDFTOTEXT = pdf;
  }
  return env;
}
export async function buildBackend() {
  const env = backendEnvironment();
  const run = args => new Promise((accept, reject) => {
    const child = spawn('cmake', args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject); child.on('exit', code => code === 0 ? accept() : reject(new Error(`CMake exited with ${code}`)));
  });
  await run(['-S', '.', '-B', 'build/backend', ...(windows ? ['-G', 'Ninja', '-DCMAKE_CXX_COMPILER=g++'] : []), '-DCMAKE_BUILD_TYPE=Release', ...(env.OPENSSL_ROOT_DIR ? [`-DOPENSSL_ROOT_DIR=${env.OPENSSL_ROOT_DIR}`] : [])]);
  await run(['--build', 'build/backend', '--parallel', '2']);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'build') await buildBackend();
  else {
    if (!existsSync(binary)) throw new Error('请先运行 pnpm build:backend 编译 C++ 后端。');
    const child = spawn(binary, [], { cwd: root, env: backendEnvironment(), stdio: 'inherit', windowsHide: true });
    child.on('error', e => { console.error(e.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code || 0; });
    process.on('SIGINT', () => child.kill('SIGINT')); process.on('SIGTERM', () => child.kill('SIGTERM'));
  }
}
