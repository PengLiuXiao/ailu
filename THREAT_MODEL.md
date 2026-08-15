# Ailu Threat Model

## Scope

Ailu is a local Obsidian plugin that orchestrates user-installed Claude Code or Codex runtimes, local Skills, Feishu CLI operations, X Article draft automation, and a user-hosted WeChat relay. It is not a security boundary around those external programs.

## Protected assets

- Vault notes, attachments, local conversation history, and Agent Memory excerpts;
- Provider API keys, relay tokens, X cookies, Feishu login state, and WeChat AppSecret/access tokens;
- publishing intent: exact note revision, prepared HTML, images, destination, and idempotency identity;
- writer ownership and recovery evidence for `.ailu/`, `~/.ailu/`, Provider settings, and deployment state.

## Trust boundaries

1. **Obsidian and Ailu.** A malicious Obsidian plugin running as the same user may read process memory or invoke Obsidian APIs. Ailu cannot isolate itself from such a plugin.
2. **Agent CLIs and model providers.** The selected CLI receives the current request and permitted context. Its network behavior, retention, tool execution, and provider policy are governed by that CLI and provider.
3. **Local Skills and executables.** Skill content and executable paths are discovered locally. Ailu does not make unreviewed local code trustworthy merely by discovering it.
4. **Feishu.** Ailu invokes an independently installed `lark-cli`; authentication remains owned by that CLI. Only user-confirmed document operations are in scope.
5. **X.** The uploader uses a separate Playwright profile and canonical X cookies. It creates a draft but never clicks final publish.
6. **WeChat relay.** Article HTML and images leave the Mac only after confirmation and travel to the user's own `wechat-relay`. The AppSecret stays on that server. Ailu does not offer a shared relay.

## Principal controls

- full access is opt-in and revalidated at the runtime execution boundary;
- Claude Code receives only user-level settings; inherited `CLAUDE_CONFIG_DIR` is removed for local/custom-provider runs, while a CC Switch directory must resolve through non-symlink directory components to a physical path outside the current Vault;
- Codex Plan and text-only turns are ephemeral, read-only, tool-free and network-disabled; ordinary restricted Codex turns are network-disabled, and App Server shutdown waits for the complete child process tree rather than only the parent process;
- conversation writes, Home settings, Provider records, X cookies, and deployment use process locks plus compare-and-swap or atomic replacement;
- canonical cookie directories reject symlinks, require private permissions, and accept only valid, unexpired X login cookies;
- Provider URLs are canonicalized, public HTTP is rejected, and invalid legacy profiles are quarantined from execution;
- attachment and publishing paths must remain beneath an authorized Vault root and may not traverse symlinks; Agent image inputs are copied from verified open-file bytes into private, content-addressed Ailu Home files and revalidated before runtime use;
- chat, Feishu and X Markdown previews accept only frozen, verified media exposed through managed short-lived object URLs; the WeChat-only remote-image fetcher permits HTTPS port 443 and revalidates public DNS addresses, redirects, size and media type;
- remote-image work has one absolute deadline across DNS, redirects and response streaming; runtime output and generated artifacts are bounded by per-event, per-turn, item-count, byte and concurrency limits before Vault side effects;
- publishing confirmation binds the exact source hashes, rendered/prepared content, preflight evidence, destination, and token fingerprint;
- WeChat drafts are read back; X drafts require same-URL persistence, exact text/table evidence, and media identity/count/order/position evidence;
- raw logs and upload artifacts are never automatically presented as safe to share; the diagnostic exporter uses an allowlist.

## Expected residual risks

- a compromised user account, OS, Obsidian process, Agent CLI, local Skill, browser profile, or self-hosted relay can access data available to that component;
- model providers may receive prompts or attachments according to their CLI configuration;
- browser and platform UI changes can break draft automation, producing a partial draft that requires manual inspection;
- X and WeChat may retain uploaded drafts independently of local rollback;
- advisory same-user locks prevent accidental concurrency, not a malicious process running as the same user;
- no security claim is made for Windows writer or child-process-tree behavior; runtime execution and unsupported writer paths fail closed before spawning.

## Explicit non-goals

- automatic publishing, group sending, payments, credential retrieval on behalf of a model, or unattended account actions;
- protecting secrets from a fully compromised local user or operating system;
- hosting user AppSecrets in a shared Ailu-operated service;
- treating arbitrary downloaded Skills, provider profiles, or relay endpoints as trusted.
