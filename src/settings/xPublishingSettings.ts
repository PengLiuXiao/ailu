export interface XPublishingSettings {
  /** Python executable used to run the local X Article uploader. */
  pythonCommand: string;
  /** Optional explicit override for the installed Skill uploader script. */
  uploadScriptPath: string;
  /** Export browser cookies only when the configured cookie file is missing or safely refreshable. */
  autoExportCookiesWhenMissing: boolean;
  /** Show the Playwright browser while preparing the draft. */
  headed: boolean;
  /** Open the returned X draft URL after a successful upload. */
  openDraftAfterSuccess: boolean;
  /** Hide YAML frontmatter from the local X Article preview. */
  previewStripFrontmatter: boolean;
  /** Add the note filename as a title only when the article has no heading. */
  previewUseFilenameTitle: boolean;
  /** Show a local-only notice that the preview is an unpublished draft. */
  previewShowDraftNotice: boolean;
}

export const DEFAULT_X_PUBLISHING_SETTINGS: XPublishingSettings = {
  pythonCommand: 'python3',
  uploadScriptPath: '',
  autoExportCookiesWhenMissing: true,
  headed: false,
  openDraftAfterSuccess: true,
  previewStripFrontmatter: true,
  previewUseFilenameTitle: false,
  previewShowDraftNotice: true,
};

export function normalizeXPublishingSettings(value: unknown): XPublishingSettings {
  const source = isRecord(value) ? value : {};
  return {
    pythonCommand: stringValue(source.pythonCommand)
      || DEFAULT_X_PUBLISHING_SETTINGS.pythonCommand,
    uploadScriptPath: stringValue(source.uploadScriptPath),
    autoExportCookiesWhenMissing: booleanValue(
      source.autoExportCookiesWhenMissing,
      DEFAULT_X_PUBLISHING_SETTINGS.autoExportCookiesWhenMissing,
    ),
    headed: booleanValue(source.headed, DEFAULT_X_PUBLISHING_SETTINGS.headed),
    openDraftAfterSuccess: booleanValue(
      source.openDraftAfterSuccess,
      DEFAULT_X_PUBLISHING_SETTINGS.openDraftAfterSuccess,
    ),
    previewStripFrontmatter: booleanValue(
      source.previewStripFrontmatter,
      DEFAULT_X_PUBLISHING_SETTINGS.previewStripFrontmatter,
    ),
    previewUseFilenameTitle: booleanValue(
      source.previewUseFilenameTitle,
      DEFAULT_X_PUBLISHING_SETTINGS.previewUseFilenameTitle,
    ),
    previewShowDraftNotice: booleanValue(
      source.previewShowDraftNotice,
      DEFAULT_X_PUBLISHING_SETTINGS.previewShowDraftNotice,
    ),
  };
}

/**
 * Keep the retired Cookie pointer only until the canonical private copy has
 * been verified. This makes a failed or lock-blocked migration retryable on
 * the next startup without allowing the legacy path back into runtime use.
 */
export function xPublishingSettingsForPersistence(
  settings: XPublishingSettings,
  legacyCookiesPath: string,
  canonicalCookiesVerified: boolean,
): XPublishingSettings & { cookiesPath?: string } {
  const legacy = legacyCookiesPath.trim();
  return {
    ...settings,
    ...(!canonicalCookiesVerified && legacy ? { cookiesPath: legacy } : {}),
  };
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
