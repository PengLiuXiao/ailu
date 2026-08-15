import type { FeishuConnectionStatus } from '../feishu/types';

export type FeishuPanelRefreshMode = 'content' | 'connection';

export interface FeishuConnectionControl {
  label: string;
  icon: string;
  mode: 'check' | 'manage';
}

export interface FeishuConnectionIndicatorInput {
  status: FeishuConnectionStatus | null;
  connected: boolean;
  accountName?: string | null;
  checking: boolean;
  checkFailed: boolean;
}

export interface FeishuConnectionIndicator {
  label: string;
  tone: 'neutral' | 'connected' | 'warning';
}

/** Connection checks are always explicit; content refreshes stay local-only. */
export function shouldCheckFeishuConnection(mode: FeishuPanelRefreshMode): boolean {
  return mode === 'connection';
}

/** One compact connection control replaces separate recovery and refresh buttons. */
export function resolveFeishuConnectionControl(
  status: FeishuConnectionStatus | null,
): FeishuConnectionControl {
  if (status === 'missing-cli') return { label: '查看安装', icon: 'package-plus', mode: 'manage' };
  if (status === 'needs-config') return { label: '连接飞书', icon: 'plug-zap', mode: 'manage' };
  if (status === 'needs-auth') return { label: '重新授权', icon: 'plug-zap', mode: 'manage' };
  if (status === 'admin-action-required') {
    return { label: '权限配置', icon: 'shield-check', mode: 'manage' };
  }
  return { label: '检查连接', icon: 'refresh-cw', mode: 'check' };
}

export function resolveFeishuConnectionIndicator(
  input: FeishuConnectionIndicatorInput,
): FeishuConnectionIndicator {
  if (input.checking) return { label: '检查中', tone: 'neutral' };
  if (input.checkFailed) return { label: '检查失败', tone: 'warning' };
  if (input.connected) {
    return { label: input.accountName?.trim() || '已连接', tone: 'connected' };
  }
  if (input.status === 'missing-cli') return { label: '未安装', tone: 'warning' };
  if (input.status === 'needs-config') return { label: '未配置', tone: 'warning' };
  if (input.status === 'needs-auth') return { label: '需授权', tone: 'warning' };
  if (input.status === 'admin-action-required') return { label: '需权限', tone: 'warning' };
  if (input.status === 'error') return { label: '连接异常', tone: 'warning' };
  return { label: '未检查', tone: 'neutral' };
}
