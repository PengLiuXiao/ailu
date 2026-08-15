import { createHash } from 'node:crypto';

import { durableRuntimeFingerprint } from '../src/storage/runtimeSnapshot';

describe('durableRuntimeFingerprint', () => {
  test('omits missing and blank runtime fingerprints', () => {
    expect(durableRuntimeFingerprint(undefined)).toBeUndefined();
    expect(durableRuntimeFingerprint('   ')).toBeUndefined();
  });

  test('stores a deterministic fixed-size digest for a verbose route snapshot', () => {
    const route = JSON.stringify({
      version: 2,
      currentCliModel: 'deepseek-v4-flash',
      routes: 'claude-route-'.repeat(160),
    });
    const expected = `sha256:${createHash('sha256').update(route, 'utf8').digest('hex')}`;

    expect(route.length).toBeGreaterThan(512);
    expect(durableRuntimeFingerprint(route)).toBe(expected);
    expect(expected).toHaveLength(71);
    expect(expected).not.toContain('deepseek-v4-flash');
  });

  test('normalizes surrounding whitespace but still distinguishes route changes', () => {
    expect(durableRuntimeFingerprint(' route-a ')).toBe(durableRuntimeFingerprint('route-a'));
    expect(durableRuntimeFingerprint('route-a')).not.toBe(durableRuntimeFingerprint('route-b'));
  });
});
