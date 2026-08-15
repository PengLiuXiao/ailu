export function markdownFilenameTitle(filename: string | null | undefined): string {
  if (!filename) return '';
  const leaf = filename.replace(/\\/g, '/').split('/').at(-1) ?? '';
  return leaf
    .replace(/\.(?:md|markdown|mdown|mkdn|mdx)$/i, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}
