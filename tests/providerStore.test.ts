import fs from 'fs';
import os from 'os';
import path from 'path';

import { SECRET_IDS } from '../src/ids';
import type { ProcessWriteLock } from '../src/storage/processWriteLock';
import { ProviderStore } from '../src/storage/providerStore';

function createSecretStorage(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    getSecret: (id: string) => values.get(id) ?? null,
    setSecret: (id: string, value: string) => {
      values.set(id, value);
    },
  };
}

function createPhysicalHomeLock(root: string): ProcessWriteLock {
  let held = true;
  const read = (relative: string): string | null => {
    try {
      return fs.readFileSync(path.join(root, relative), 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  };
  return {
    acquire: async () => {
      held = true;
      return true;
    },
    assertHeld: async () => {
      if (!held) throw new Error('test Home lock is not held');
    },
    readTextFile: async relative => read(relative),
    compareAndSwapTextFile: async (relative, expected, replacement) => {
      if (!held) throw new Error('test Home lock is not held');
      const current = read(relative);
      if (current !== expected) return { swapped: false, value: current };
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, replacement, { encoding: 'utf8', mode: 0o600 });
      return { swapped: true, value: replacement };
    },
    release: async () => {
      held = false;
    },
  };
}

function createStore(
  secrets: ReturnType<typeof createSecretStorage>,
  env: NodeJS.ProcessEnv,
): ProviderStore {
  return new ProviderStore(secrets, env, {
    canWrite: () => true,
    processWriteLock: createPhysicalHomeLock(env.AILU_HOME!),
  });
}

describe('ProviderStore', () => {
  let tempDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-provider-'));
    env = { AILU_HOME: tempDir };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('makes the first profile default for an agent', async () => {
    const store = createStore(createSecretStorage(), env);
    const profile = await store.save({
      agentId: 'codex',
      name: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-5.4',
    });
    expect(profile.isDefault).toBe(true);
    expect(store.find('codex')?.id).toBe(profile.id);
  });

  test('redacts secrets during export', async () => {
    const store = createStore(createSecretStorage(), env);
    await store.save({
      agentId: 'claude',
      name: 'anthropic',
      apiKey: 'sk-secret-value',
    });
    expect(store.exportProfiles()[0]).toMatchObject({
      apiKey: '',
      apiKeyRedacted: true,
    });
    expect(JSON.stringify(store.exportProfiles())).not.toContain('sk-secret-value');
    expect(fs.readFileSync(path.join(tempDir, 'providers.json'), 'utf8'))
      .not.toContain('sk-secret-value');
  });

  test.each([
    'https://user:password@example.com/v1',
    'https://example.com/v1?token=secret-value',
  ])('never exports credential-bearing quarantined URL %s', (baseUrl) => {
    fs.writeFileSync(path.join(tempDir, 'providers.json'), JSON.stringify({
      version: 1,
      profiles: [{
        id: 'quarantined-secret-url',
        agentId: 'claude',
        name: 'legacy',
        baseUrl,
        secretRef: null,
      }],
    }));
    const exported = JSON.stringify(createStore(createSecretStorage(), env).exportProfiles());
    expect(exported).not.toContain('password');
    expect(exported).not.toContain('secret-value');
    expect(JSON.parse(exported)).toEqual([
      expect.objectContaining({ baseUrl: '' }),
    ]);
  });

  test('does not read plaintext API keys from canonical provider metadata', () => {
    const secrets = createSecretStorage();
    fs.writeFileSync(path.join(tempDir, 'providers.json'), JSON.stringify({
      version: 1,
      profiles: [{
        id: 'legacy-profile',
        agentId: 'codex',
        name: 'legacy',
        apiKey: 'sk-legacy-secret',
        baseUrl: 'https://api.example.com/v1',
        model: 'example-model',
        defaultModel: 'example-model',
        models: ['example-model'],
        wireApi: 'chat',
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      }],
    }));

    const before = fs.readFileSync(path.join(tempDir, 'providers.json'), 'utf8');
    const store = createStore(secrets, env);
    expect(store.find('codex')?.apiKey).toBe('');
    expect(secrets.getSecret(SECRET_IDS.providerApiKey('legacy-profile'))).toBeNull();
    expect(fs.readFileSync(path.join(tempDir, 'providers.json'), 'utf8')).toBe(before);
  });

  test('fails closed when stored metadata names an unsupported agent', () => {
    fs.writeFileSync(path.join(tempDir, 'providers.json'), JSON.stringify({
      version: 1,
      profiles: [{
        id: 'retired-profile',
        agentId: 'retired-agent',
        name: 'retired',
      }],
    }));

    const store = createStore(createSecretStorage(), env);

    expect(() => store.list()).toThrow('invalid profile');
  });

  test('does not fall back to a legacy SecretStorage id in normal provider reads', () => {
    const secrets = createSecretStorage({
      'retired-provider-api-key:legacy-profile': 'sk-legacy-secret',
    });
    fs.writeFileSync(path.join(tempDir, 'providers.json'), JSON.stringify({
      version: 1,
      profiles: [{
        id: 'legacy-profile',
        agentId: 'claude',
        name: 'Moonshot',
        apiKey: '',
        baseUrl: 'https://api.moonshot.cn/anthropic',
        model: 'kimi-k3',
        defaultModel: 'kimi-k3',
        models: ['kimi-k3'],
        wireApi: 'chat',
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      }],
    }));

    const store = createStore(secrets, env);
    const profile = store.find('claude');
    expect(profile?.apiKey).toBe('');
    expect(profile?.anthropicAuthMode).toBe('authToken');
    expect(secrets.getSecret(SECRET_IDS.providerApiKey('legacy-profile'))).toBeNull();
  });

  test('journal-migrates the pre-secretRef canonical credential without losing it', async () => {
    const legacySecretId = SECRET_IDS.providerApiKey('legacy-profile');
    const secrets = createSecretStorage({ [legacySecretId]: 'sk-existing-user-secret' });
    fs.writeFileSync(path.join(tempDir, 'providers.json'), JSON.stringify({
      version: 1,
      profiles: [{
        id: 'legacy-profile',
        agentId: 'claude',
        name: 'Existing provider',
        apiKey: '',
        baseUrl: 'https://api.example.com/anthropic',
        defaultModel: 'existing-model',
        models: ['existing-model'],
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      }],
    }));
    const store = createStore(secrets, env);

    expect(store.find('claude')?.apiKey).toBe('sk-existing-user-secret');
    await store.migrateLegacySecretPointers();
    await store.auditCanonicalSecretPointers();

    const metadata = JSON.parse(fs.readFileSync(path.join(tempDir, 'providers.json'), 'utf8')) as {
      profiles: Array<{ secretRef?: string | null; apiKey?: string }>;
    };
    const secretRef = metadata.profiles[0]?.secretRef;
    expect(secretRef).toMatch(/^ailu-provider-secret-v2-/);
    expect(metadata.profiles[0]?.apiKey).toBe('');
    expect(secrets.getSecret(String(secretRef))).toBe('sk-existing-user-secret');
    expect(secrets.getSecret(legacySecretId)).toBe('sk-existing-user-secret');
    expect(createStore(secrets, env).find('claude')?.apiKey).toBe('sk-existing-user-secret');
  });

  test('migrates a keyless pre-secretRef profile to an explicit null pointer', async () => {
    fs.writeFileSync(path.join(tempDir, 'providers.json'), JSON.stringify({
      version: 1,
      profiles: [{ id: 'local-profile', agentId: 'codex', name: 'Local provider' }],
    }));
    const store = createStore(createSecretStorage(), env);

    await store.migrateLegacySecretPointers();
    await store.auditCanonicalSecretPointers();

    const metadata = JSON.parse(fs.readFileSync(path.join(tempDir, 'providers.json'), 'utf8')) as {
      profiles: Array<{ secretRef?: string | null }>;
    };
    expect(metadata.profiles[0]?.secretRef).toBeNull();
  });

  test('infers official Anthropic API key authentication for old profiles', async () => {
    const store = createStore(createSecretStorage(), env);
    const profile = await store.save({
      agentId: 'claude',
      name: 'Claude',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-sonnet-4-6',
    });
    expect(profile.anthropicAuthMode).toBe('apiKey');
  });

  test('validates imported provider profiles before saving', async () => {
    const store = createStore(createSecretStorage(), env);
    await expect(store.importProfiles([{ agentId: 'unknown', name: 'invalid' }]))
      .rejects.toThrow('invalid agentId');
    expect(store.list()).toEqual([]);
  });

  test('rejects new insecure URLs while quarantining a legacy profile for repair', async () => {
    const store = createStore(createSecretStorage(), env);
    await expect(store.save({
      agentId: 'codex',
      name: 'unsafe',
      apiKey: 'secret',
      baseUrl: 'http://api.example.com/v1',
    })).rejects.toThrow('必须使用 HTTPS');
    await expect(store.importProfiles([{
      agentId: 'codex',
      name: 'unsafe import',
      baseUrl: 'https://api.example.com/v1?token=secret',
    }])).rejects.toThrow('查询参数或片段');

    const secrets = createSecretStorage({
      [SECRET_IDS.providerApiKey('unsafe-on-disk')]: 'sk-legacy-safe',
    });
    fs.writeFileSync(path.join(tempDir, 'providers.json'), JSON.stringify({
      version: 1,
      profiles: [{
        id: 'unsafe-on-disk',
        agentId: 'claude',
        name: 'unsafe on disk',
        baseUrl: 'http://api.example.com/anthropic',
      }],
    }));
    const legacyStore = createStore(secrets, env);
    const quarantined = legacyStore.list();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.id).toBe('unsafe-on-disk');
    expect(quarantined[0]?.baseUrl).toBe('http://api.example.com/anthropic');
    expect(quarantined[0]?.configurationError).toContain('必须使用 HTTPS');
    expect(legacyStore.find('claude', 'unsafe-on-disk')).toBeNull();

    await legacyStore.migrateLegacySecretPointers();
    await legacyStore.auditCanonicalSecretPointers();
    await legacyStore.save({
      agentId: 'claude',
      id: 'unsafe-on-disk',
      name: 'repaired provider',
      apiKey: 'sk-legacy-safe',
      baseUrl: 'https://api.example.com/anthropic',
    });
    const repaired = legacyStore.find('claude', 'unsafe-on-disk');
    expect(repaired).toMatchObject({
      baseUrl: 'https://api.example.com/anthropic',
      apiKey: 'sk-legacy-safe',
    });
    expect(repaired).not.toHaveProperty('configurationError');
  });

  test('keeps one default per agent', async () => {
    const store = createStore(createSecretStorage(), env);
    const first = await store.save({ agentId: 'claude', name: 'first' });
    const second = await store.save({ agentId: 'claude', name: 'second', isDefault: true });
    expect(store.find('claude')?.id).toBe(second.id);
    expect(store.list('claude').find(profile => profile.id === first.id)?.isDefault).toBe(false);
  });

  test('normalizes profile models and wire API defaults', async () => {
    const store = createStore(createSecretStorage(), env);
    const profile = await store.save({
      agentId: 'codex',
      name: 'deepseek',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    });
    expect(profile.defaultModel).toBe('deepseek-chat');
    expect(profile.models).toEqual(['deepseek-chat']);
    expect(profile.wireApi).toBe('chat');
  });

  test('uses responses wire API for the official OpenAI endpoint', async () => {
    const store = createStore(createSecretStorage(), env);
    const profile = await store.save({
      agentId: 'codex',
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-5.4',
    });
    expect(profile.wireApi).toBe('responses');
  });

  test('persists an immutable secretRef across restart and metadata-only writes', async () => {
    const secrets = createSecretStorage();
    const first = createStore(secrets, env);
    const profile = await first.save({
      agentId: 'codex',
      name: 'openai',
      apiKey: 'sk-persisted',
      defaultModel: 'gpt-5.4',
    });
    const initialMetadata = JSON.parse(
      fs.readFileSync(path.join(tempDir, 'providers.json'), 'utf8'),
    ) as { profiles: Array<{ id: string; secretRef?: string | null }> };
    const initialRef = initialMetadata.profiles.find(item => item.id === profile.id)?.secretRef;
    expect(initialRef).toMatch(/^ailu-provider-secret-v2-/);

    const restarted = createStore(secrets, env);
    expect(restarted.find('codex', profile.id)?.apiKey).toBe('sk-persisted');
    await restarted.setActiveModel(profile.id, 'gpt-5.4-mini');

    const updatedMetadata = JSON.parse(
      fs.readFileSync(path.join(tempDir, 'providers.json'), 'utf8'),
    ) as { profiles: Array<{ id: string; secretRef?: string | null }> };
    expect(updatedMetadata.profiles.find(item => item.id === profile.id)?.secretRef).toBe(initialRef);
    expect(createStore(secrets, env).find('codex', profile.id)?.apiKey).toBe('sk-persisted');
  });

  test('never rebinds an active credential when importing a redacted profile', async () => {
    const secrets = createSecretStorage();
    const store = createStore(secrets, env);
    const profile = await store.save({ agentId: 'claude', name: 'Claude', apiKey: 'sk-keep' });
    await store.importProfiles(store.exportProfiles());
    expect(createStore(secrets, env).find('claude', profile.id)?.apiKey).toBe('');
  });

  test('does not send an existing credential to a URL supplied by a redacted import', async () => {
    const secrets = createSecretStorage();
    const store = createStore(secrets, env);
    const profile = await store.save({
      agentId: 'codex',
      name: 'Trusted provider',
      apiKey: 'sk-existing-secret',
      baseUrl: 'https://trusted.example/v1',
    });
    await store.importProfiles([{
      ...store.exportProfiles()[0],
      id: profile.id,
      name: 'Untrusted endpoint',
      baseUrl: 'https://untrusted.example/v1',
      apiKeyRedacted: true,
    }]);
    expect(createStore(secrets, env).find('codex', profile.id)).toMatchObject({
      baseUrl: 'https://untrusted.example/v1',
      apiKey: '',
    });
  });

  test('allows the lock-authorized startup migration while UI writes remain disabled', async () => {
    const legacySecretId = SECRET_IDS.providerApiKey('startup-profile');
    const secrets = createSecretStorage({ [legacySecretId]: 'sk-startup-secret' });
    fs.writeFileSync(path.join(tempDir, 'providers.json'), JSON.stringify({
      version: 1,
      profiles: [{ id: 'startup-profile', agentId: 'claude', name: 'Startup provider' }],
    }));
    const store = new ProviderStore(secrets, env, {
      canWrite: () => false,
      processWriteLock: createPhysicalHomeLock(env.AILU_HOME!),
    });

    await expect(store.migrateLegacySecretPointers()).resolves.toBeUndefined();
    await expect(store.auditCanonicalSecretPointers()).resolves.toBeUndefined();
    expect(store.find('claude', 'startup-profile')?.apiKey).toBe('sk-startup-secret');
    await expect(store.save({ agentId: 'claude', name: 'Blocked UI write' }))
      .rejects.toThrow('read-only');
  });

  test('fails closed when a mutation has no physical Home lock', async () => {
    const store = new ProviderStore(createSecretStorage(), env, { canWrite: () => true });
    await expect(store.save({ agentId: 'codex', name: 'openai' }))
      .rejects.toThrow('physical Home writer lock');
  });

  test('audits explicit no-credential state but rejects an interrupted missing pointer', async () => {
    const metadata = (secretRef: 'omit' | null): string => `${JSON.stringify({
      version: 1,
      profiles: [{
        id: 'credential-optional',
        agentId: 'codex',
        name: 'optional',
        apiKey: '',
        ...(secretRef === 'omit' ? {} : { secretRef }),
      }],
    }, null, 2)}\n`;
    const store = createStore(createSecretStorage(), env);

    fs.writeFileSync(path.join(tempDir, 'providers.json'), metadata(null));
    await expect(store.auditCanonicalSecretPointers()).resolves.toBeUndefined();

    fs.writeFileSync(path.join(tempDir, 'providers.json'), metadata('omit'));
    await expect(store.auditCanonicalSecretPointers())
      .rejects.toThrow('AILU_PROVIDER_SECRET_POINTER_MISSING');
  });
});
