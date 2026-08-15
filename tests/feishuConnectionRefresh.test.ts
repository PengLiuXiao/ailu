import { describe, expect, test } from 'vitest';

import {
  resolveFeishuConnectionControl,
  resolveFeishuConnectionIndicator,
  shouldCheckFeishuConnection,
} from '../src/ui/feishuConnectionRefresh';

describe('Feishu connection refresh policy', () => {
  test('keeps every content refresh local and checks only on an explicit connection refresh', () => {
    expect(shouldCheckFeishuConnection('content')).toBe(false);
    expect(shouldCheckFeishuConnection('connection')).toBe(true);
  });

  test('resolves one compact connection control for every connection state', () => {
    expect(resolveFeishuConnectionControl(null)).toEqual({
      label: '检查连接', icon: 'refresh-cw', mode: 'check',
    });
    expect(resolveFeishuConnectionControl('connected').mode).toBe('check');
    expect(resolveFeishuConnectionControl('error').mode).toBe('check');
    expect(resolveFeishuConnectionControl('missing-cli')).toEqual({
      label: '查看安装', icon: 'package-plus', mode: 'manage',
    });
    expect(resolveFeishuConnectionControl('needs-config').label).toBe('连接飞书');
    expect(resolveFeishuConnectionControl('needs-auth').label).toBe('重新授权');
    expect(resolveFeishuConnectionControl('admin-action-required').label).toBe('权限配置');
  });

  test('shows a failed explicit check ahead of a cached connected account', () => {
    expect(resolveFeishuConnectionIndicator({
      status: 'connected',
      connected: true,
      accountName: '山不止行',
      checking: false,
      checkFailed: true,
    })).toEqual({ label: '检查失败', tone: 'warning' });
    expect(resolveFeishuConnectionIndicator({
      status: 'connected',
      connected: true,
      accountName: '山不止行',
      checking: false,
      checkFailed: false,
    })).toEqual({ label: '山不止行', tone: 'connected' });
  });
});
