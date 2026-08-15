import { createHash } from 'node:crypto';

/**
 * Runtime route fingerprints are equality tokens, not recoverable launch
 * configuration. Persist a fixed-size digest so a validated but verbose
 * CC Switch route snapshot can never exceed the durable turn schema bound.
 */
export function durableRuntimeFingerprint(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}
