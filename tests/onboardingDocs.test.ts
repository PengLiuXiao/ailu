import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const readme = fs.readFileSync(
  fileURLToPath(new URL('../README.md', import.meta.url)),
  'utf8',
);
const guide = fs.readFileSync(
  fileURLToPath(new URL('../docs/COMPLETE_SETUP.md', import.meta.url)),
  'utf8',
);

describe('complete onboarding documentation', () => {
  test('documents public Release and anonymous source installation', () => {
    expect(readme).toContain('GitHub Release');
    expect(readme).toContain('git clone https://github.com/mcncarl/ailu.git');
    expect(readme).toContain('商业使用：允许，但必须遵守 AGPL-3.0-or-later');
    expect(readme).toContain('商业部署、定制、培训与技术支持：可联系');
    expect(guide).toContain('公开仓库不需要 GitHub Token、Deploy Key 或账号登录');
    expect(guide).toContain('git clone --branch 0.1.0 --depth 1');
    expect(readme).not.toContain('本私有仓库');
    expect(guide).not.toContain('获授权使用者');
  });

  test('links the complete integration guide from the core first-run flow', () => {
    expect(readme).toContain('[《Ailu 完整安装与集成配置》](docs/COMPLETE_SETUP.md)');
    expect(readme).toContain('Ubuntu 服务器、公众号固定出口 IPv4 白名单');
    expect(readme).toContain('Chrome 登录态与 X Cookie 导入');
    expect(readme).toContain('在 Ailu 草稿区完成的中国版飞书配置');
    expect(readme).toContain('memoryctl --actor ailu version --json');
  });

  test('documents the supported relay deployment and readiness contract', () => {
    for (const required of [
      'Ubuntu 24.04 VPS',
      'test "$(command -v node)" = "/usr/bin/node"',
      '`/usr/bin/node --version` 必须显示 `v22.x`',
      'sudo -H -u wechat-relay-build /usr/bin/node --version',
      'WECHAT_APP_ID=<公众号 AppID>',
      'WECHAT_APP_SECRET=<公众号 AppSecret>',
      'RELAY_TOKEN=<openssl 生成的随机 Token>',
      'openssl rand -base64 48',
      'http://127.0.0.1:18794/v1/health',
      'http://127.0.0.1:18794/v1/ready',
      '{"ready":true}',
      'Tailscale Serve',
      'Tailscale 官方 Linux 安装说明',
      'HTTPS MagicDNS',
      '不要开启 Tailscale Funnel',
      '域名 + Caddy',
      'Caddy 官方 Debian/Ubuntu 安装说明',
      '永远不要开放 18794',
      'Ailu 当前没有“测试中转连接”按钮',
      'AppSecret 永远不进入 Ailu',
    ]) {
      expect(guide).toContain(required);
    }
  });

  test('documents X Skill discovery, dependencies, Cookie import, and draft-only acceptance', () => {
    for (const required of [
      '~/.agents/skills/x-article-draft-uploader/',
      'scripts/upload_markdown_to_x_article.py',
      'scripts/parse_markdown.py',
      'scripts/export_x_cookies_from_chrome.py',
      'x-article-draft-uploader-v1.0.1',
      '9f679d9f28d656eb01b60d806faa709f85173c51',
      'skills@1.5.22',
      '--requirement "$AILU_X_SKILL_HOME/requirements.txt"',
      'x-article-persistence-v1',
      'examples/smoke-test.md',
      '`preflight.errors` 为空',
      '目标 Skill 已存在；未覆盖',
      '从 Chrome 导入',
      '粘贴 JSON',
      '选择 JSON',
      '~/.ailu/secrets/x/cookies.json',
      '`auth_token` 和 `ct0`',
      'Chrome 的 `Default` Profile',
      'X 草稿预检通过',
      'X 草稿已创建并严格核验',
      '不点击 X 的最终发布按钮',
      '不要安装会继续变化的任意 `main` 快照',
      '商业用途，必须事先取得作者明确书面授权',
      '该限制不因 Ailu 使用 AGPL 而改变，也不适用于 Ailu 核心',
    ]) {
      expect(guide).toContain(required);
    }
  });

  test('documents Ailu-managed Feishu auth and optional Memory v2 handshake', () => {
    for (const required of [
      'npx @larksuite/cli@latest install',
      'brand=feishu',
      'lark-cli auth status --json --verify',
      'memoryctl --actor ailu version --json',
      '`ready=true`',
      '`runtime_api_version=2`',
      '`writer_protocol_version=2`',
      '出现 **沉淀到记忆**',
      'memoryctl --actor codex doctor',
      '`ailu` actor 只允许 `version`、`retrieve` 和 `write`',
    ]) {
      expect(guide).toContain(required);
    }
    expect(guide).not.toContain('memoryctl --actor ailu doctor');
  });

  test('contains no secret values or unfinished placeholders', () => {
    expect(guide).not.toMatch(/auth_token["']?\s*[:=]\s*["'][^<\s]/i);
    expect(guide).not.toMatch(/ct0["']?\s*[:=]\s*["'][^<\s]/i);
    expect(guide).not.toMatch(/AppSecret\s*[:=]\s*[^<\s`]/i);
    expect(guide).not.toMatch(/\b(?:TODO|TBD|FIXME)\b/);
  });
});
