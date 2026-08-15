import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildFeishuDriveFolderListArgs,
  buildFeishuCreateDocumentArgs,
  buildFeishuFetchDocumentArgs,
  buildFeishuUpdateDocumentArgs,
  buildFeishuWikiNodeListArgs,
  buildFeishuWikiSpaceListArgs,
  buildLarkAuthStatusArgs,
  buildLarkAuthorizationArgs,
  isValidLarkAuthorizationRecord,
  LarkCliService,
  missingLarkScopes,
  parseFeishuDriveFolderPage,
  parseFeishuPlaceholderBlockIds,
  parseFeishuWikiNodes,
  parseFeishuWikiSpaces,
  parseLarkCliFailure,
} from '../src/feishu/larkCli';
import {
  larkCliAuthorizationRecordPath,
} from '../src/paths';

const PUBLISHING_SCOPES = [
  'docx:document:create',
  'docx:document:readonly',
  'docx:document:write_only',
  'docs:document.media:upload',
  'drive:drive:readonly',
  'space:document:retrieve',
  'wiki:space:retrieve',
  'wiki:node:retrieve',
];

describe('LarkCliService commands', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('requests publishing plus destination-read scopes with split-flow authorization', () => {
    expect(buildLarkAuthorizationArgs()).toEqual([
      'auth',
      'login',
      '--scope',
      PUBLISHING_SCOPES.join(' '),
      '--no-wait',
      '--json',
    ]);
  });

  test('verifies the stored token when checking authorization state', () => {
    expect(buildLarkAuthStatusArgs()).toEqual([
      'auth',
      'status',
      '--json',
      '--verify',
    ]);
  });

  test('compares all app scopes with the user authorization', () => {
    expect(missingLarkScopes(
      ['im:chat:read', 'base:app:read', 'calendar:calendar:read'],
      ['im:chat:read', 'calendar:calendar:read'],
    )).toEqual(['base:app:read']);
  });

  test('accepts current and previous publishing records plus the legacy all-mode record', () => {
    const record = {
      authorizationMode: 'publishing',
      scopeVersion: 3,
      cliVersion: '1.2.3',
      authorizedAt: '2026-07-30T08:00:00.000Z',
    };
    expect(isValidLarkAuthorizationRecord(record)).toBe(true);
    expect(isValidLarkAuthorizationRecord({ ...record, scopeVersion: 2 })).toBe(true);
    expect(isValidLarkAuthorizationRecord({
      ...record,
      authorizationMode: 'all',
      scopeVersion: 1,
    })).toBe(true);
    expect(isValidLarkAuthorizationRecord({ ...record, authorizationMode: 'docs' })).toBe(false);
    expect(isValidLarkAuthorizationRecord({ ...record, scopeVersion: 1 })).toBe(false);
  });

  test('detects an independently installed system CLI', () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    expect(cli.discoverCli()).toMatchObject({
      path: path.join(env.AILU_HOME!, 'bin', 'lark-cli'),
      cliStatus: 'ready',
    });
  });

  test('reuses an existing global document authorization without a plugin-local record', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const grantedScopes = [...PUBLISHING_SCOPES];
    Reflect.set(cli, 'run', buildConnectionRunner(grantedScopes, grantedScopes));

    expect(cli.getCachedConnectionState()).toBeNull();
    const connection = await cli.getConnectionState();
    expect(connection).toMatchObject({
      status: 'connected',
      connected: true,
      permissionsComplete: true,
      authorizationMode: 'publishing',
    });
    expect(cli.getCachedConnectionState()).toBe(connection);
  });

  test('coalesces concurrent connection checks into one lark-cli inspection', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const grantedScopes = [...PUBLISHING_SCOPES];
    const runner = buildConnectionRunner(grantedScopes, grantedScopes);
    const calls: string[][] = [];
    Reflect.set(cli, 'run', async (args: string[]) => {
      calls.push(args);
      await Promise.resolve();
      return runner(args);
    });

    const [first, second] = await Promise.all([
      cli.getConnectionState(),
      cli.getConnectionState(),
    ]);

    expect(first).toBe(second);
    expect(calls.filter(args => args[0] === 'auth' && args[1] === 'status')).toHaveLength(2);
  });

  test('runs a full capability verification after an in-flight basic check', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const grantedScopes = [...PUBLISHING_SCOPES];
    const runner = buildConnectionRunner(grantedScopes, grantedScopes);
    const calls: string[][] = [];
    let releaseBasicCheck!: () => void;
    let markBasicCheckStarted!: () => void;
    const basicCheckStarted = new Promise<void>((resolve) => {
      markBasicCheckStarted = resolve;
    });
    const basicCheckGate = new Promise<void>((resolve) => {
      releaseBasicCheck = resolve;
    });
    let verifiedStatusCalls = 0;
    Reflect.set(cli, 'run', async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'auth' && args[1] === 'check') return commandResult({ granted: true });
      if (args[0] === 'auth' && args[1] === 'status' && args.includes('--verify')) {
        verifiedStatusCalls += 1;
        if (verifiedStatusCalls === 1) {
          markBasicCheckStarted();
          await basicCheckGate;
        }
      }
      return runner(args);
    });

    const basic = cli.getConnectionState();
    await basicCheckStarted;
    const verified = cli.getConnectionState(true);
    releaseBasicCheck();

    const basicConnection = await basic;
    const verifiedConnection = await verified;
    expect(basicConnection.connected).toBe(true);
    expect(verifiedConnection.connected).toBe(true);
    expect(verifiedConnection.capabilities.docs.verified).toBe(true);
    expect(verifiedConnection.capabilities.drive.verified).toBe(true);
    expect(calls.filter(args => args[0] === 'auth' && args[1] === 'check')).toHaveLength(2);
  });

  test('keeps a transient capability-check failure out of the reauthorization flow', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const grantedScopes = [...PUBLISHING_SCOPES];
    const runner = buildConnectionRunner(grantedScopes, grantedScopes);
    const calls: string[][] = [];
    Reflect.set(cli, 'run', async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'auth' && args[1] === 'check') {
        if (args.some(arg => arg.includes('docx:document:create'))) {
          return {
            ...commandResult({}),
            code: 1,
            stdout: '',
            stderr: JSON.stringify({
              error: {
                type: 'transport',
                subtype: 'request_timeout',
                message: 'temporary network failure',
              },
            }),
          };
        }
        return commandResult({ granted: true });
      }
      return runner(args);
    });

    const connection = await cli.getConnectionState(true);

    expect(connection).toMatchObject({
      status: 'error',
      connected: false,
      permissionsComplete: true,
      accountOpenId: 'ou_test',
    });
    expect(connection.message).toContain('无需重新授权');
    expect(connection.capabilities.docs).toMatchObject({
      granted: true,
      verified: false,
    });
    expect(calls.some(args => args[0] === 'auth' && args[1] === 'login')).toBe(false);
  });

  test('requests reauthorization only after an explicit missing-scope response', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const grantedScopes = [...PUBLISHING_SCOPES];
    const runner = buildConnectionRunner(grantedScopes, grantedScopes);
    Reflect.set(cli, 'run', async (args: string[]) => {
      if (args[0] === 'auth' && args[1] === 'check') {
        if (args.some(arg => arg.includes('docx:document:create'))) {
          return {
            ...commandResult({}),
            code: 1,
            stdout: '',
            stderr: JSON.stringify({
              error: {
                type: 'authorization',
                subtype: 'missing_scope',
                message: 'missing required scope',
                missing_scopes: ['docx:document:create'],
              },
            }),
          };
        }
        return commandResult({ granted: true });
      }
      return runner(args);
    });

    const connection = await cli.getConnectionState(true);

    expect(connection).toMatchObject({
      status: 'needs-auth',
      connected: false,
      permissionsComplete: false,
      accountOpenId: 'ou_test',
    });
    expect(connection.message).toContain('明确的权限或令牌拒绝');
  });

  test('checks configuration through safe auth status without reading app secrets', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const calls: string[][] = [];
    const grantedScopes = [...PUBLISHING_SCOPES];
    const runner = buildConnectionRunner(grantedScopes, grantedScopes);
    Reflect.set(cli, 'run', async (args: string[]) => {
      calls.push(args);
      return runner(args);
    });

    const connection = await cli.getConnectionState();

    expect(connection.status).toBe('connected');
    expect(calls.some(args => args[0] === 'config' && args[1] === 'show')).toBe(false);
    expect(calls[0]).toEqual(['auth', 'status', '--json']);
  });

  test('fails closed when the active CLI profile is Lark instead of Feishu', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const calls: string[][] = [];
    Reflect.set(cli, 'run', async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'auth' && args[1] === 'status') {
        return commandResult({
          brand: 'lark',
          identity: 'user',
          identities: {
            user: {
              status: 'ready',
              available: true,
              tokenStatus: 'valid',
              scope: PUBLISHING_SCOPES.join(' '),
            },
          },
        });
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const connection = await cli.getConnectionState();
    expect(connection).toMatchObject({
      status: 'needs-config',
      connected: false,
      configured: false,
    });
    expect(connection.message).toContain('中国版飞书（Feishu）');
    expect(calls.some(args => args[0] === 'auth' && args[1] === 'check')).toBe(false);
  });

  test('creates only an explicit Feishu configuration when no CLI profile exists', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const calls: string[][] = [];
    Reflect.set(cli, 'run', async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'auth' && args[1] === 'status') {
        return {
          ...commandResult({}),
          code: 1,
        };
      }
      if (args[0] === 'config' && args[1] === 'init') return commandResult({ ok: true });
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    await cli.ensureConfigured();
    expect(calls[1]).toEqual([
      'config',
      'init',
      '--new',
      '--brand',
      'feishu',
      '--lang',
      'zh',
    ]);
  });

  test('never starts or completes authorization through an international Lark profile', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const calls: string[][] = [];
    let brand = 'lark';
    Reflect.set(cli, 'run', async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'whoami') return commandResult({ brand, profile: 'profile-one' });
      if (args[0] === 'auth' && args[1] === 'status') {
        return commandResult({
          brand,
          identities: { user: { openId: 'ou_test' } },
        });
      }
      if (args[0] === 'auth' && args[1] === 'login' && args.includes('--no-wait')) {
        return commandResult({
          device_code: 'device-code',
          verification_url: 'https://accounts.feishu.cn/device',
          expires_in: 600,
        });
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    await expect(cli.startAuthorization()).rejects.toThrow('中国版飞书');
    expect(calls).toHaveLength(1);

    brand = 'feishu';
    const progress = await cli.startAuthorization();
    brand = 'lark';
    await expect(cli.completeAuthorization(progress.attemptId!)).rejects.toThrow('brand=feishu');
    expect(calls.some(args => args.includes('--device-code'))).toBe(false);
  });

  test.each(['missing', 'expired']) (
    'allows a %s user without openId to authorize, then requires the bound account',
    async (initialTokenStatus) => {
      const env = createSystemCliFixture(tempDirs);
      const cli = new LarkCliService(env);
      const calls: string[][] = [];
      let authenticated = false;
      Reflect.set(cli, 'run', async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'whoami') return feishuWhoami('profile-cn');
        if (args[0] === 'auth' && args[1] === 'status') {
          return commandResult({
            brand: 'feishu',
            identity: 'user',
            identities: {
              user: authenticated
                ? {
                    status: 'ready',
                    available: true,
                    tokenStatus: 'valid',
                    openId: 'ou_newly_authorized',
                    userName: 'New User',
                    scope: PUBLISHING_SCOPES.join(' '),
                  }
                : {
                    status: initialTokenStatus,
                    available: false,
                    tokenStatus: initialTokenStatus,
                    scope: '',
                  },
            },
          });
        }
        if (args[0] === 'auth' && args[1] === 'login' && args.includes('--no-wait')) {
          return commandResult({
            device_code: `device-${initialTokenStatus}`,
            verification_url: 'https://accounts.feishu.cn/device',
            expires_in: 600,
            requested_scopes: PUBLISHING_SCOPES,
          });
        }
        if (args[0] === 'auth' && args[1] === 'login' && args.includes('--device-code')) {
          authenticated = true;
          return commandResult({ ok: true });
        }
        if (args[0] === 'auth' && args[1] === 'check') {
          return commandResult({ granted: true });
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      });

      const progress = await cli.startAuthorization();
      expect(progress).toMatchObject({
        phase: 'waiting-auth',
        verificationUrl: 'https://accounts.feishu.cn/device',
      });
      const connection = await cli.completeAuthorization(progress.attemptId!);

      expect(connection).toMatchObject({
        status: 'connected',
        connected: true,
        accountOpenId: 'ou_newly_authorized',
        permissionsComplete: true,
      });
      const authorizationWrites = calls.filter(
        args => args[0] === 'auth' && args[1] === 'login',
      );
      expect(authorizationWrites).toHaveLength(2);
      expect(authorizationWrites[0]).toEqual(expect.arrayContaining([
        '--no-wait',
        '--profile',
        'profile-cn',
      ]));
      expect(authorizationWrites[1]).toEqual(expect.arrayContaining([
        '--device-code',
        `device-${initialTokenStatus}`,
        '--profile',
        'profile-cn',
      ]));
    },
  );

  test('does not expose a plugin action that logs out the shared CLI account', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const run = vi.fn();
    Reflect.set(cli, 'run', run);

    await expect(cli.disconnect()).rejects.toThrow('本机所有工作流共享');
    expect(run).not.toHaveBeenCalled();
  });

  test('serializes the multi-step publishing transaction', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    Reflect.set(cli, 'run', async (args: string[]) => {
      if (args[0] === 'whoami') return feishuWhoami();
      if (args[0] === 'auth' && args[1] === 'status') {
        return commandResult({
          brand: 'feishu',
          identities: { user: { openId: 'ou_test' } },
        });
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });
    let release!: () => void;
    const first = cli.runPublishingOperation(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    await Promise.resolve();

    await expect(cli.runPublishingOperation(async () => undefined))
      .rejects.toThrow('另一项飞书同步仍在进行');

    release();
    await first;
    await expect(cli.runPublishingOperation(async () => 'done')).resolves.toBe('done');
  });

  test('pins the real Feishu profile and account when whoami omits openId', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const calls: string[][] = [];
    Reflect.set(cli, 'cachedConnectionState', {
      connected: true,
      accountOpenId: 'ou_checked',
    });
    let writeInput: string | Buffer | undefined;
    Reflect.set(cli, 'run', async (
      args: string[],
      options?: { input?: string | Buffer },
    ) => {
      calls.push(args);
      if (args[0] === 'whoami') return feishuWhoami('profile-cn');
      if (args[0] === 'auth' && args[1] === 'status') {
        return commandResult({
          brand: 'feishu',
          identities: { user: { openId: 'ou_checked' } },
        });
      }
      if (args[0] === 'docs' && args[1] === '+create') {
        writeInput = options?.input;
        return commandResult({ document_id: 'doc-new', url: 'https://feishu.cn/doc-new' });
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    await cli.runPublishingOperation(() => cli.createDocument(
      '# 标题\n\n## 正文\n',
      '',
      '标题',
    ));

    const write = calls.find(args => args[0] === 'docs' && args[1] === '+create');
    expect(write).toEqual([
      'docs',
      '+create',
      '--as',
      'user',
      '--doc-format',
      'markdown',
      '--parent-position',
      'my_library',
      '--title',
      '标题',
      '--content',
      '-',
      '--json',
      '--profile',
      'profile-cn',
    ]);
    expect(writeInput).toBe('## 正文\n');
    expect(calls[0]).toEqual(['whoami', '--json']);
    expect(calls[1]).toEqual(['auth', 'status', '--json', '--profile', 'profile-cn']);
  });

  test('does not report connected when auth status omits the account openId', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    const grantedScopes = [...PUBLISHING_SCOPES];
    const runner = buildConnectionRunner(grantedScopes, grantedScopes);
    Reflect.set(cli, 'run', async (args: string[]) => {
      const result = await runner(args);
      if (args[0] !== 'auth' || args[1] !== 'status') return result;
      const payload = JSON.parse(result.stdout) as {
        identities: { user: Record<string, unknown> };
      };
      delete payload.identities.user.openId;
      return commandResult(payload);
    });

    const connection = await cli.getConnectionState();
    expect(connection).toMatchObject({
      status: 'error',
      connected: false,
      accountOpenId: null,
    });
    expect(connection.message).toContain('账号标识');
  });

  test('rejects a stale cached connected state that has no account binding', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    Reflect.set(cli, 'cachedConnectionState', {
      connected: true,
      accountOpenId: null,
    });
    Reflect.set(cli, 'run', async (args: string[]) => {
      if (args[0] === 'whoami') return feishuWhoami('profile-cn');
      if (args[0] === 'auth' && args[1] === 'status') {
        return commandResult({
          brand: 'feishu',
          identities: { user: { openId: 'ou_current' } },
        });
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });
    const operation = vi.fn(async () => 'must-not-run');

    await expect(cli.runPublishingOperation(operation)).rejects.toThrow('缺少账号标识');
    expect(operation).not.toHaveBeenCalled();
  });

  test('updates title and title-free body in one supported Markdown overwrite payload', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    pinFeishuProfile(cli, 'profile-cn');
    const calls: Array<{ args: string[]; input?: string | Buffer }> = [];
    Reflect.set(cli, 'run', async (
      args: string[],
      options?: { input?: string | Buffer },
    ) => {
      calls.push({ args, input: options?.input });
      return commandResult({ result: 'success' });
    });

    await cli.updateDocument(
      'doxcn123',
      '# A \\<tag\\> & \\[x\\] \\*literal\\*\n\n## Section\n\nBody\n',
    );

    expect(calls).toEqual([{
      args: [
        'docs',
        '+update',
        '--as',
        'user',
        '--doc',
        'doxcn123',
        '--command',
        'overwrite',
        '--doc-format',
        'markdown',
        '--content',
        '-',
        '--json',
        '--profile',
        'profile-cn',
      ],
      input: '<title>A &lt;tag&gt; &amp; [x] *literal*</title>\n## Section\n\nBody\n',
    }]);
  });

  test('serializes authorization across views and cancels only its own attempt', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    Reflect.set(cli, 'run', async (args: string[]) => {
      if (args[0] === 'whoami') return feishuWhoami('profile-cn');
      if (args[0] === 'auth' && args[1] === 'status') {
        return commandResult({ brand: 'feishu', identities: { user: { openId: 'ou_checked' } } });
      }
      if (args[0] === 'auth' && args[1] === 'login' && args.includes('--no-wait')) {
        return commandResult({
          device_code: 'device-code',
          verification_url: 'https://accounts.feishu.cn/device',
          expires_in: 600,
        });
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const first = await cli.startAuthorization();
    await expect(cli.startAuthorization()).rejects.toThrow('另一窗口正在进行飞书授权');
    expect(cli.cancelAuthorization('not-owner')).toBe(false);
    expect(cli.cancelAuthorization(first.attemptId!)).toBe(true);
    await expect(cli.startAuthorization()).resolves.toMatchObject({ phase: 'waiting-auth' });
  });

  test('finds or creates only the canonical Ailu default folder', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    pinFeishuProfile(cli);
    const calls: string[][] = [];
    Reflect.set(cli, 'run', async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'drive' && args[1] === '+search') {
        return commandResult({ results: [] });
      }
      if (args[0] === 'drive' && args[1] === '+create-folder') {
        return commandResult({ folder_token: 'fldcn-ailu', url: 'https://example.com/ailu' });
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    await expect(cli.findOrCreateDefaultFolder()).resolves.toEqual({
      folderToken: 'fldcn-ailu',
      url: 'https://example.com/ailu',
    });
    expect(calls.filter(args => args[1] === '+search').map(args => args[args.indexOf('--query') + 1]))
      .toEqual(['Ailu']);
    const createCall = calls.find(args => args[1] === '+create-folder');
    expect(createCall?.[createCall.indexOf('--name') + 1]).toBe('Ailu');
  });

  test('detects partial authorization when a document scope is missing', async () => {
    const env = createSystemCliFixture(tempDirs);
    fs.writeFileSync(larkCliAuthorizationRecordPath(env), JSON.stringify({
      authorizationMode: 'all',
      scopeVersion: 1,
      cliVersion: '9.9.9',
      authorizedAt: '2026-07-30T08:00:00.000Z',
    }));
    const cli = new LarkCliService(env);
    const appScopes = PUBLISHING_SCOPES.filter(scope => scope !== 'docx:document:write_only');
    const grantedScopes = [...appScopes];
    Reflect.set(cli, 'run', buildConnectionRunner(grantedScopes, appScopes));

    const connection = await cli.getConnectionState();
    expect(connection).toMatchObject({
      status: 'needs-auth',
      connected: false,
      permissionsComplete: false,
    });
    expect(connection.capabilities.docs.granted).toBe(false);
  });

  test('returns to scanning when the verified user token has expired', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    Reflect.set(cli, 'run', async (args: string[]) => {
      if (args[0] === 'config') return commandResult({ appId: 'cli_test' });
      if (args[0] === 'auth' && args[1] === 'status') {
        return commandResult({
          brand: 'feishu',
          identities: {
            user: {
              status: 'missing',
              available: false,
              tokenStatus: 'expired',
              message: 'refresh token expired',
              scope: '',
            },
          },
        });
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const connection = await cli.getConnectionState();
    expect(connection).toMatchObject({
      status: 'needs-auth',
      connected: false,
      permissionsComplete: false,
    });
  });

  test('uses user identity, current CLI flags and stdin for document writes', () => {
    expect(buildFeishuCreateDocumentArgs('fldcn123', '标题')).toEqual([
      'docs',
      '+create',
      '--as',
      'user',
      '--doc-format',
      'markdown',
      '--parent-token',
      'fldcn123',
      '--title',
      '标题',
      '--content',
      '-',
      '--json',
    ]);
    expect(buildFeishuUpdateDocumentArgs('doxcn123')).toContain('overwrite');
    expect(buildFeishuUpdateDocumentArgs('doxcn123')).toContain('-');
    expect(buildFeishuCreateDocumentArgs('', '标题')).toContain('my_library');
    expect(buildFeishuCreateDocumentArgs('', '标题')).toContain('--title');
    expect(() => buildFeishuCreateDocumentArgs('', '')).toThrow('标题不能为空');
    expect(buildFeishuFetchDocumentArgs('doxcn123')).toContain('with-ids');
  });

  test('builds read-only Drive and Wiki tree commands with explicit user identity', () => {
    const driveArgs = buildFeishuDriveFolderListArgs('folderToken', 'nextPage');
    expect(driveArgs.slice(0, 5)).toEqual(['drive', 'files', 'list', '--as', 'user']);
    expect(JSON.parse(driveArgs[driveArgs.indexOf('--params') + 1])).toEqual({
      folder_token: 'folderToken',
      page_size: 200,
      page_token: 'nextPage',
    });
    expect(buildFeishuWikiSpaceListArgs()).toEqual([
      'wiki',
      '+space-list',
      '--as',
      'user',
      '--page-all',
      '--page-limit',
      '0',
      '--json',
    ]);
    expect(buildFeishuWikiNodeListArgs('my_library', 'wikiParent')).toEqual([
      'wiki',
      '+node-list',
      '--space-id',
      'my_library',
      '--as',
      'user',
      '--parent-node-token',
      'wikiParent',
      '--page-all',
      '--page-limit',
      '0',
      '--json',
    ]);
  });

  test('normalizes only selectable folder and Wiki fields from CLI envelopes', () => {
    expect(parseFeishuDriveFolderPage({
      data: {
        files: [
          { type: 'folder', token: 'folderA', name: '项目', url: 'https://example/folderA' },
          { type: 'docx', token: 'docA', name: '文档' },
        ],
        has_more: true,
        next_page_token: 'page2',
      },
    })).toEqual({
      folders: [{ token: 'folderA', name: '项目', url: 'https://example/folderA' }],
      hasMore: true,
      nextPageToken: 'page2',
    });
    expect(parseFeishuWikiSpaces({
      data: { spaces: [{ space_id: '123', name: '团队知识库', visibility: 'private' }] },
    })).toEqual([{ spaceId: '123', name: '团队知识库' }]);
    expect(parseFeishuWikiNodes({
      data: {
        nodes: [{
          space_id: '123',
          node_token: 'wikiNode',
          parent_node_token: 'wikiParent',
          title: '项目资料',
          has_child: true,
          obj_token: 'docToken',
        }],
      },
    })).toEqual([{
      spaceId: '123',
      nodeToken: 'wikiNode',
      parentNodeToken: 'wikiParent',
      title: '项目资料',
      hasChild: true,
    }]);
  });

  test('paginates Drive folders and ignores documents in the same directory', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    pinFeishuProfile(cli);
    const calls: string[][] = [];
    Reflect.set(cli, 'run', async (args: string[]) => {
      calls.push(args);
      const params = JSON.parse(args[args.indexOf('--params') + 1]) as { page_token?: string };
      return commandResult({
        data: params.page_token
          ? {
            files: [{ type: 'folder', token: 'folderB', name: '归档', url: '' }],
            has_more: false,
          }
          : {
            files: [
              { type: 'folder', token: 'folderA', name: '项目', url: '' },
              { type: 'docx', token: 'docA', name: '正文' },
            ],
            has_more: true,
            next_page_token: 'page2',
          },
      });
    });

    await expect(cli.listDriveFolders('parentFolder')).resolves.toEqual([
      { token: 'folderA', name: '项目', url: '' },
      { token: 'folderB', name: '归档', url: '' },
    ]);
    expect(calls).toHaveLength(2);
  });

  test('locates image placeholders in fetched XML blocks', () => {
    const content = [
      '<title id="doc">文章</title>',
      '<p id="blk_image_1">AILU_FEISHU_IMAGE_0001_abc</p>',
      '<p id="blk_body">正文</p>',
      '<p id="blk_image_2"><span>AILU_FEISHU_IMAGE_0002_def</span></p>',
    ].join('');
    expect(parseFeishuPlaceholderBlockIds(content, [
      'AILU_FEISHU_IMAGE_0001_abc',
      'AILU_FEISHU_IMAGE_0002_def',
    ])).toEqual(new Map([
      ['AILU_FEISHU_IMAGE_0001_abc', 'blk_image_1'],
      ['AILU_FEISHU_IMAGE_0002_def', 'blk_image_2'],
    ]));
  });

  test('refuses to delete a placeholder block that also contains article text', () => {
    const placeholder = 'AILU_FEISHU_IMAGE_0001_abc';
    const content = `<p id="blk_mixed">文字前 ${placeholder} 文字后</p>`;
    expect(parseFeishuPlaceholderBlockIds(content, [placeholder])).toEqual(new Map());
  });

  test('moves uploaded images to their placeholders before removing placeholder blocks', async () => {
    const env = createSystemCliFixture(tempDirs);
    const cli = new LarkCliService(env);
    pinFeishuProfile(cli);
    const calls: string[][] = [];
    Reflect.set(cli, 'run', async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'docs' && args[1] === '+fetch') {
        return commandResult({
          document: {
            content: '<p id="blk_anchor">AILU_FEISHU_IMAGE_0001_abc</p>',
          },
        });
      }
      if (args[0] === 'docs' && args[1] === '+media-insert') {
        return commandResult({ block_id: 'blk_image' });
      }
      if (args[0] === 'docs' && args[1] === '+update') return commandResult({ result: 'success' });
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    await cli.insertAssets('doxcn123', '/vault', [{
      placeholder: 'AILU_FEISHU_IMAGE_0001_abc',
      vaultPath: 'images/cover.png',
      fileName: 'cover.png',
      mimeType: 'image/png',
      contentHash: 'abc',
      alt: '封面',
    }]);

    expect(calls.map(args => args[1])).toEqual([
      '+fetch',
      '+media-insert',
      '+update',
      '+update',
    ]);
    expect(calls[1]).not.toContain('--caption');
    expect(calls[1]).not.toContain('封面');
    expect(calls[2]).toEqual(expect.arrayContaining([
      'block_move_after',
      'blk_anchor',
      'blk_image',
    ]));
    expect(calls[3]).toEqual(expect.arrayContaining(['block_delete', 'blk_anchor']));
  });

  test('maps permission configuration URLs without adding confirmation flags', () => {
    const error = parseLarkCliFailure(
      1,
      '',
      JSON.stringify({
        error: {
          message: 'missing scope',
          console_url: 'https://open.feishu.cn/app/permission',
          permission_violations: [{ scope: 'docx:document:create' }],
        },
      }),
    );
    expect(error.message).toBe('missing scope');
    expect(error.consoleUrl).toBe('https://open.feishu.cn/app/permission');
    expect(error.permissionViolations).toEqual(['docx:document:create']);
    expect(error.confirmationRequired).toBe(false);
  });

  test('recognizes the CLI high-risk confirmation gate', () => {
    const error = parseLarkCliFailure(
      10,
      '',
      JSON.stringify({
        error: {
          type: 'confirmation_required',
          message: 'action requires confirmation',
        },
      }),
    );
    expect(error.confirmationRequired).toBe(true);
  });
});

interface MockCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
}

function commandResult(stdout: unknown): MockCommandResult {
  return {
    code: 0,
    stdout: JSON.stringify(stdout),
    stderr: '',
    cancelled: false,
    timedOut: false,
  };
}

function feishuWhoami(profile = 'feishu-test-profile'): MockCommandResult {
  return commandResult({
    appId: 'cli_test',
    available: true,
    brand: 'feishu',
    profile,
    tokenStatus: 'valid',
    onBehalfOf: { type: 'user' },
  });
}

function pinFeishuProfile(cli: LarkCliService, profile = 'feishu-test-profile'): void {
  Reflect.set(cli, 'activePublishingProfile', {
    profile,
    accountOpenId: null,
  });
}

function buildConnectionRunner(
  grantedScopes: string[],
  appScopes: string[],
): (args: string[]) => Promise<MockCommandResult> {
  return async (args: string[]) => {
    if (args[0] === 'config') {
      return commandResult({ appId: 'cli_test' });
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      return commandResult({
        brand: 'feishu',
        identity: 'user',
        identities: {
          user: {
            status: 'ready',
            available: true,
            tokenStatus: 'valid',
            userName: 'Test User',
            openId: 'ou_test',
            scope: grantedScopes.join(' '),
          },
        },
      });
    }
    if (args[0] === 'auth' && args[1] === 'scopes') {
      return commandResult({ userScopes: appScopes });
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
}

function createSystemCliFixture(tempDirs: string[]): NodeJS.ProcessEnv {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-lark-state-'));
  tempDirs.push(tempDir);
  const binDir = path.join(tempDir, 'bin');
  const env = {
    AILU_HOME: tempDir,
    PATH: [binDir, process.env.PATH ?? ''].join(path.delimiter),
  } as NodeJS.ProcessEnv;
  const binaryPath = path.join(binDir, process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, '#!/bin/sh\nprintf "lark-cli 9.9.9\\n"\n');
  fs.chmodSync(binaryPath, 0o755);
  fs.mkdirSync(path.dirname(larkCliAuthorizationRecordPath(env)), { recursive: true });
  return env;
}
