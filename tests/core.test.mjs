import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { binary, backendEnvironment } from '../scripts/backend.mjs';

test('C++ 核心：中文英文检索、正文切片、Markdown、上海日历与密码校验', async () => {
  const result = await promisify(execFile)(binary, ['--self-test'], { env: backendEnvironment(), windowsHide: true });
  assert.match(result.stdout, /C\+\+ core tests passed/);
});
