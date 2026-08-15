# Privacy

Ailu is local-first, but it coordinates tools that can use network services. This document separates local storage from user-triggered transfers.

## Stored locally

- conversations and recovery state under the current Vault's `.ailu/` directory;
- Provider metadata without API keys in `~/.ailu/providers.json`;
- Provider API keys and the WeChat relay token in Obsidian SecretStorage;
- X cookies in `~/.ailu/secrets/x/cookies.json`;
- content-addressed image attachment copies in `~/.ailu/frozen-attachments/`, created from already verified Vault bytes before an Agent turn and protected by private directory/file permissions;
- runtime caches and bounded logs under `~/.ailu/`;
- Feishu authorization metadata without the CLI's credentials;
- frontmatter links and hashes needed to update previously created drafts/documents.

Ailu does not automatically write ordinary chat history into shared Agent Memory. Explicit memory writes use the locally installed `memoryctl` gateway and its own policy.

## Network activity

- Claude Code and Codex may contact their configured model providers when the user sends a request. Ailu does not override the provider's privacy policy.
- Chat, Feishu, and X previews do not let MarkdownRenderer load remote media or arbitrary local paths. Verified frozen bytes use short-lived managed `blob:` URLs; unresolved media becomes a local placeholder. Only the WeChat snapshot path may fetch a remote note image, and it restricts the request to HTTPS port 443, revalidates every public DNS/redirect target, bounds the response, and verifies the media type before preview or upload preparation.
- Feishu content is sent only after the user confirms a create or sync operation, through the independently authenticated `lark-cli`.
- X content and verified local media are sent only after the user confirms draft creation. The uploader controls a separate browser session and does not click Publish.
- WeChat article HTML, cover, and body images are sent only after confirmation to the user's self-hosted `wechat-relay`, which then calls the official WeChat API.
- Local template rendering and preview do not require an Ailu service or account.

## Data that must not be shared in issues

Do not publish X cookies, SecretStorage exports, raw logs, X run directories, screenshots, draft URLs, media IDs, absolute file paths, Vault data, relay databases, server environment files, or deployment backups. Use the in-product redacted diagnostic action and inspect the result before sharing.

## Deletion and retention

Ailu preserves recovery evidence instead of silently deleting it. It also does not automatically delete content-addressed copies under `~/.ailu/frozen-attachments/`; identical bytes reuse the same file, and removal requires an explicit user action. Deleting local conversations, frozen attachments, X diagnostics, relay state, platform drafts, or deployment backups is a separate user-controlled operation. Removing Ailu does not automatically delete data held by Claude/Codex providers, Feishu, X, WeChat, or a self-hosted relay.
