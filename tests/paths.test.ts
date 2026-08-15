import os from 'os';
import path from 'path';

import {
  ailuHome,
  larkCliAuthorizationRecordPath,
  providersPath,
  runtimeManagedDir,
  vaultAiluDir,
} from '../src/paths';

describe('paths', () => {
  test('uses AILU_HOME when configured', () => {
    const env = {
      AILU_HOME: '/tmp/ailu-test',
    } as NodeJS.ProcessEnv;
    expect(ailuHome(env)).toBe('/tmp/ailu-test');
    expect(runtimeManagedDir('codex', env)).toBe('/tmp/ailu-test/runtimes/codex');
    expect(larkCliAuthorizationRecordPath(env))
      .toBe('/tmp/ailu-test/lark/authorization.json');
    expect(providersPath(env)).toBe('/tmp/ailu-test/providers.json');
  });

  test('defaults to the isolated Ailu home', () => {
    expect(ailuHome({}))
      .toBe(path.join(os.homedir(), '.ailu'));
  });

  test('ignores unrelated environment variables', () => {
    expect(ailuHome({
      OTHER_PRODUCT_HOME: '/tmp/other-product-home',
    }))
      .toBe(path.join(os.homedir(), '.ailu'));
  });

  test('uses the isolated vault directory', () => {
    expect(vaultAiluDir('/vault'))
      .toBe(path.join('/vault', '.ailu'));
  });
});
