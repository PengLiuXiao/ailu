import {
  buildProviderAuthHeaders,
  inferAnthropicAuthMode,
  normalizeProviderBaseUrl,
  requiresProviderApiKey,
} from '../src/utils/providerAuth';

describe('provider authentication', () => {
  test('infers API key only for the official Anthropic host', () => {
    expect(inferAnthropicAuthMode('claude', 'Claude', 'https://api.anthropic.com')).toBe('apiKey');
    expect(inferAnthropicAuthMode('claude', 'Moonshot', 'https://api.moonshot.cn/anthropic')).toBe('authToken');
  });

  test('builds exactly one Anthropic authentication header', () => {
    expect(buildProviderAuthHeaders({
      agentId: 'claude',
      apiKey: 'k',
      anthropicAuthMode: 'authToken',
    })).toEqual({
      Authorization: 'Bearer k',
      'anthropic-version': '2023-06-01',
    });
    expect(buildProviderAuthHeaders({
      agentId: 'claude',
      apiKey: 'k',
      anthropicAuthMode: 'apiKey',
    })).toEqual({
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
    });
  });

  test('allows keyless loopback providers only', () => {
    expect(requiresProviderApiKey('http://127.0.0.1:8080')).toBe(false);
    expect(requiresProviderApiKey('https://api.moonshot.cn/anthropic')).toBe(true);
    expect(buildProviderAuthHeaders({
      agentId: 'codex',
      apiKey: '',
    })).toEqual({});
  });

  test.each([
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
    ['http://[::1]:8080/v1/', 'http://[::1]:8080/v1'],
    ['https://API.Example.com:443/v1/../anthropic/', 'https://api.example.com/anthropic'],
  ])('returns a canonical URL whose authority matches the validated host', (input, expected) => {
    expect(normalizeProviderBaseUrl(input)).toBe(expected);
  });

  test.each([
    'http://127.0.0.1\\\\@evil.example/v1',
    'http://localhost.evil.example/v1',
    'https://user:secret@example.com/v1',
    'https://example.com/v1?token=secret',
    'https://example.com/v1#fragment',
    'https://example.com/v1\nmalformed',
  ])('rejects ambiguous or credential-bearing provider URL %s', input => {
    expect(() => normalizeProviderBaseUrl(input)).toThrow(/Base URL/);
  });
});
