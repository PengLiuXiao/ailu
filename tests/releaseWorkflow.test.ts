import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

const releaseWorkflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');

describe('release workflow', () => {
  test('only requests GitHub-hosted artifact attestations for a public repository', () => {
    expect(releaseWorkflow).toMatch(
      /- name: Generate artifact attestation\n(?:\s*#.*\n)*\s*if: \$\{\{ github\.event\.repository\.visibility == 'public' \}\}\n\s*uses: actions\/attest@/,
    );
  });

  test('still creates a release when the hosted attestation step is skipped', () => {
    expect(releaseWorkflow).toMatch(
      /- name: Create GitHub release\n\s*env:\n\s*GH_TOKEN: \$\{\{ github\.token \}\}\n\s*run: \|/,
    );
  });
});
