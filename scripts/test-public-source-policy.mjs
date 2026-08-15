import {
  assertExactPublicInventory,
  assertExactGitIndexState,
  assertPublicText,
} from './public-source-policy.mjs';

function expectFailure(operation, message) {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(message);
}

assertExactPublicInventory(
  ['README.md', 'src/main.ts'],
  ['README.md', 'src/main.ts'],
);
expectFailure(
  () => assertExactPublicInventory(
    ['README.md', 'src/main.ts'],
    ['README.md', 'src/main.ts', 'src/renamed-private.ts'],
  ),
  'An unreviewed renamed file must fail the public inventory.',
);
expectFailure(
  () => assertExactPublicInventory(
    ['README.md', 'assets/ailu-ribbon-icon.png'],
    ['README.md', 'assets/ailu-ribbon-icon.png', 'assets/unknown.bin'],
  ),
  'An unknown binary must fail the public inventory.',
);
expectFailure(
  () => assertExactPublicInventory(['README.md'], ['README.md', 'src/link.ts']),
  'A symlink-shaped unexpected entry must fail before publication.',
);
expectFailure(
  () => assertPublicText(
    'README.md',
    `Local path: ${['', 'Users', 'private-user', 'Vault'].join('/')}`,
  ),
  'A personal home path must fail the public content policy.',
);
expectFailure(
  () => assertPublicText(
    'tests/leak.test.ts',
    ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
  ),
  'Private-key material must fail even inside tests.',
);
expectFailure(
  () => assertPublicText(
    'src/leak.ts',
    ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz123456'].join(''),
  ),
  'A GitHub token must fail the public content policy.',
);
expectFailure(
  () => assertPublicText(
    'src/leak.ts',
    ['auth_token=', 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'].join(''),
  ),
  'A live-looking X cookie must fail the public content policy.',
);
assertPublicText('tests/example.test.ts', 'Synthetic path: /Users/example/Vault');

assertExactGitIndexState(
  ['README.md', 'src/main.ts'],
  [
    { mode: '100644', stage: '0', path: 'README.md' },
    { mode: '100644', stage: '0', path: 'src/main.ts' },
  ],
  true,
);
expectFailure(
  () => assertExactGitIndexState(
    ['README.md'],
    [{ mode: '100644', stage: '0', path: 'README.md' }],
    false,
  ),
  'A staged blob that differs from the reviewed working tree must fail.',
);
expectFailure(
  () => assertExactGitIndexState(
    ['README.md'],
    [{ mode: '120000', stage: '0', path: 'README.md' }],
    true,
  ),
  'A staged symlink must fail the public index policy.',
);
expectFailure(
  () => assertExactGitIndexState(
    ['README.md'],
    [{ mode: '100644', stage: '1', path: 'README.md' }],
    true,
  ),
  'An unmerged staged entry must fail the public index policy.',
);

process.stdout.write('Verified public source policy self-tests.\n');
