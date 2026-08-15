# Security Policy

## Supported versions

Until the first Ailu Release exists, security fixes are evaluated against the latest commit on the private repository's `main` branch. After releases begin, fixes will target the latest published release. Locally modified bundles are not supported versions.

## Reporting a vulnerability

Do not open an issue for vulnerabilities, exposed credentials, private Vault content, draft URLs, media IDs, or diagnostic archives. GitHub private vulnerability reporting is not currently enabled for this private repository. Contact the repository owner through an existing private channel first, without including secrets, and request a private reporting channel. Include only the minimum reproduction needed to explain the problem and replace real content with synthetic examples.

Never attach any of the following:

- X Cookie JSON or browser-profile data;
- Provider API keys, Feishu credentials, relay tokens, WeChat AppSecret/access tokens, or SecretStorage exports;
- raw `~/.ailu/logs/`, X upload run directories, screenshots, draft URLs, `media_id` values, absolute Vault paths, or deployment backups;
- a real `data.json`, `providers.json`, `.ailu/` conversation store, Agent Memory database, or Obsidian Vault.

Use Ailu's “复制脱敏诊断” action when possible. Its output is intentionally allowlisted, but you should still read it before sharing.

## Security defaults

- Claude Code and Codex full access are disabled by default.
- Public relay endpoints must use HTTPS; plain HTTP is accepted only for loopback addresses.
- Relay tokens must encode at least 32 cryptographically random bytes.
- Provider secrets and the relay token use Obsidian SecretStorage. X cookies use `~/.ailu/secrets/x/cookies.json` with private directory/file permissions.
- Publishing and X Article flows create drafts only and require an explicit final confirmation.
- Ailu does not install Agent CLIs, Skills, `lark-cli`, browser automation, or the WeChat relay.

These defaults do not turn third-party Agent CLIs into a sandbox. Enabling full access allows the selected CLI to exercise the permissions described by its own runtime. Review [THREAT_MODEL.md](THREAT_MODEL.md) before enabling it.

## Disclosure process

We will acknowledge a complete report, reproduce it against a supported version, and coordinate remediation and disclosure through the agreed private channel. Do not test against infrastructure, accounts, Vaults, or public-account credentials you do not own or have explicit authorization to use.
