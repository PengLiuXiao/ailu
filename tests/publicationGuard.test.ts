import {
  assertPublishingDestinationUnchanged,
  assertPublishingSourceUnchanged,
  createPublishingDestinationIdentity,
  isCurrentPublishingSource,
  maskedPublishingAppId,
  type PublishingSourceIdentity,
} from '../src/publishing/publicationGuard';

const RELAY_TOKEN = 'r'.repeat(48);

function identity(overrides: Partial<PublishingSourceIdentity> = {}): PublishingSourceIdentity {
  return {
    revision: 7,
    filePath: '文章/A.md',
    snapshotContentHash: 'snapshot-a',
    themeContentHash: 'theme-a',
    renderedHtml: '<p>正文</p>',
    preparedContentHash: 'prepared-a',
    preflightIntegrityHash: 'integrity-a',
    ...overrides,
  };
}

describe('publishing source guards', () => {
  test('rejects an older overlapping reload after a newer file becomes current', () => {
    expect(isCurrentPublishingSource(4, '文章/A.md', 5, '文章/B.md')).toBe(false);
    expect(isCurrentPublishingSource(5, '文章/B.md', 5, '文章/B.md')).toBe(true);
  });

  test.each([
    ['revision', { revision: 8 }],
    ['file', { filePath: '文章/B.md' }],
    ['snapshot', { snapshotContentHash: 'snapshot-b' }],
    ['theme', { themeContentHash: 'theme-b' }],
    ['rendered HTML', { renderedHtml: '<p>新正文</p>' }],
    ['prepared article', { preparedContentHash: 'prepared-b' }],
    ['preflight integrity', { preflightIntegrityHash: 'integrity-b' }],
  ])('blocks upload when %s changes after confirmation', (_label, changed) => {
    expect(() => assertPublishingSourceUnchanged(identity(), identity(changed)))
      .toThrow('确认期间已变化');
  });

  test('blocks upload while the current source is dirty or unavailable', () => {
    expect(() => assertPublishingSourceUnchanged(identity(), null))
      .toThrow('确认期间已变化');
  });

  test('accepts the exact source and preflight identity', () => {
    expect(() => assertPublishingSourceUnchanged(identity(), identity())).not.toThrow();
  });

  test('binds final confirmation to the relay, AppID, and token', () => {
    const captured = createPublishingDestinationIdentity({
      relayUrl: 'https://relay.example.test/',
      appId: 'wx1234567890abcdef',
      relayToken: RELAY_TOKEN,
    });
    expect(captured).toMatchObject({
      relayUrl: 'https://relay.example.test',
      relayHost: 'relay.example.test',
      appId: 'wx1234567890abcdef',
    });
    expect(maskedPublishingAppId(captured.appId)).toBe('wx12••••cdef');
    expect(() => assertPublishingDestinationUnchanged(captured, {
      ...captured,
      relayUrl: 'https://other.example.test',
    })).toThrow('公众号目标');
    expect(() => assertPublishingDestinationUnchanged(captured, {
      ...captured,
      relayTokenFingerprint: 'changed',
    })).toThrow('中转凭据');
    expect(createPublishingDestinationIdentity({
      relayUrl: 'https://relay.example.test/account-a/',
      appId: '',
      relayToken: RELAY_TOKEN,
    }).relayHost).toBe('relay.example.test/account-a');
    expect(() => createPublishingDestinationIdentity({
      relayUrl: 'https://relay.example.test',
      appId: '',
      relayToken: 'short-token',
    })).toThrow('至少 32 个随机字节');
  });
});
