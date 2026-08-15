import {
  DEFAULT_PUBLISHING_SETTINGS,
  normalizePublishingSettings,
} from '../src/settings/publishingSettings';

describe('publishing settings', () => {
  test('defaults to a local-first paper-ink workflow', () => {
    expect(normalizePublishingSettings(null)).toEqual(DEFAULT_PUBLISHING_SETTINGS);
  });

  test('normalizes imported values and preserves upload safety gates', () => {
    expect(normalizePublishingSettings({
      themeId: 'paper-ink',
      transport: 'localRelay',
      relayUrl: ' https://relay.example.test/ ',
      appId: ' app-id ',
      confirmBeforeUpload: true,
      verifyAfterUpload: true,
    })).toMatchObject({
      themeId: 'paper-ink',
      bodyFontId: 'paper-kaiti',
      bodyFontSize: 17,
      transport: 'localRelay',
      relayUrl: 'https://relay.example.test/',
      appId: 'app-id',
      confirmBeforeUpload: true,
      verifyAfterUpload: true,
    });
  });

  test('rejects unsupported publishing transports', () => {
    expect(normalizePublishingSettings({ transport: 'remoteCloud' }).transport)
      .toBe('localRelay');
  });

  test('migrates every unavailable theme choice to Paper Ink', () => {
    expect(normalizePublishingSettings({ themeId: 'unavailable-theme' }).themeId).toBe('paper-ink');
  });

  test('preserves every selectable local template', () => {
    for (const themeId of [
      'soft-pastel',
      'open-design-archive',
      'vellum-indigo',
      'editorial-tri-tone',
      'pink-script',
      'playful-peach',
      'capsule-color',
    ] as const) {
      expect(normalizePublishingSettings({ themeId }).themeId).toBe(themeId);
    }
  });

  test('keeps body typography independent and normalized', () => {
    expect(normalizePublishingSettings({
      themeId: 'capsule-color',
      bodyFontId: 'source-serif',
      bodyFontSize: 15,
    })).toMatchObject({
      themeId: 'capsule-color',
      bodyFontId: 'source-serif',
      bodyFontSize: 15,
    });
    expect(normalizePublishingSettings({
      bodyFontId: 'unsafe-font',
      bodyFontSize: 99,
    })).toMatchObject({
      bodyFontId: 'paper-kaiti',
      bodyFontSize: 20,
    });
  });
});
