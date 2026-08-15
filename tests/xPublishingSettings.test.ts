import {
  DEFAULT_X_PUBLISHING_SETTINGS,
  normalizeXPublishingSettings,
  xPublishingSettingsForPersistence,
} from '../src/settings/xPublishingSettings';

describe('X publishing settings', () => {
  test('defaults to the local draft-only workflow', () => {
    expect(normalizeXPublishingSettings(null)).toEqual(DEFAULT_X_PUBLISHING_SETTINGS);
  });

  test('normalizes explicit paths and preview preferences', () => {
    expect(normalizeXPublishingSettings({
      pythonCommand: ' /opt/homebrew/bin/python3 ',
      uploadScriptPath: ' ~/.agents/skills/x-article-draft-uploader/upload.py ',
      cookiesPath: ' /tmp/x-cookies.json ',
      autoExportCookiesWhenMissing: false,
      headed: true,
      openDraftAfterSuccess: false,
      previewStripFrontmatter: false,
      previewUseFilenameTitle: true,
      previewShowDraftNotice: false,
    })).toEqual({
      pythonCommand: '/opt/homebrew/bin/python3',
      uploadScriptPath: '~/.agents/skills/x-article-draft-uploader/upload.py',
      autoExportCookiesWhenMissing: false,
      headed: true,
      openDraftAfterSuccess: false,
      previewStripFrontmatter: false,
      previewUseFilenameTitle: true,
      previewShowDraftNotice: false,
    });
  });

  test('falls back safely and never retains cookie contents or legacy secrets', () => {
    const normalized = normalizeXPublishingSettings({
      pythonCommand: ' ',
      cookiesPath: '',
      headed: 'true',
      playwrightToken: 'must-not-be-stored',
      cookieContents: [{ name: 'auth_token', value: 'must-not-be-stored' }],
      enableDebugLog: true,
      localUploaderScriptPath: '/legacy/plugin/upload.py',
    });

    expect(normalized).toEqual(DEFAULT_X_PUBLISHING_SETTINGS);
    expect(JSON.stringify(normalized)).not.toContain('must-not-be-stored');
    expect(JSON.stringify(normalized)).not.toContain('/legacy/plugin/upload.py');
    expect(JSON.stringify(normalized)).not.toContain('/tmp/x');
  });

  test('preserves only the legacy Cookie pointer until the canonical copy is verified', () => {
    expect(xPublishingSettingsForPersistence(
      DEFAULT_X_PUBLISHING_SETTINGS,
      ' /tmp/legacy-x-cookies.json ',
      false,
    )).toMatchObject({ cookiesPath: '/tmp/legacy-x-cookies.json' });
    expect(xPublishingSettingsForPersistence(
      DEFAULT_X_PUBLISHING_SETTINGS,
      '/tmp/legacy-x-cookies.json',
      true,
    )).not.toHaveProperty('cookiesPath');
  });
});
