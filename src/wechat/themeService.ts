/**
 * Merge streaming deltas with runtimes that occasionally resend the complete
 * accumulated text. This helper is shared by non-theme generation dialogs.
 */
export function mergeRuntimeText(current: string, incoming: string): string {
  if (!incoming || incoming === current) return current;
  if (incoming.startsWith(current)) return incoming;
  if (incoming.length >= 128 && current.startsWith(incoming)) return current;
  return current + incoming;
}
