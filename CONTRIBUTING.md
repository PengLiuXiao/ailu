# Contributing

## Before opening a change

- Use synthetic notes, paths, account IDs, media IDs, cookies, URLs, and screenshots.
- Do not commit `data.json`, `.ailu/`, `~/.ailu/`, Agent Memory data, browser profiles, raw diagnostics, deployment receipts, build outputs, or any secret.
- Do not add a bundled Skill, CLI, relay credential, or external executable without documenting its trust and license boundary.
- Do not weaken final confirmation, source/destination binding, same-URL persistence, media identity/order/position verification, writer locks, or SecretStorage boundaries merely to make a failing workflow pass.

## Development

Use a supported Node.js version and install the exact lockfile:

```bash
npm ci
npm test
npm run lint
npm run build
npm run verify:release
```

Generated `main.js` and `build-attestation.json` are release artifacts and are not source inputs. A release maintainer builds them from a reviewed source tree.

## Pull requests

Explain the user-visible behavior, trust-boundary changes, migration/rollback behavior, and tests. Security-sensitive changes should include negative tests proving that malformed paths, URLs, credentials, stale state, concurrency, and partial platform results still fail closed.

Never make a repository, package, release, deployment, or hosted endpoint public on behalf of the maintainer without the maintainer's explicit approval for that exact action.
