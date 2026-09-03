import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { ailuHome } from '../paths';

export interface PiBridgeConfig {
  /** Full-access turns skip every prompt but keep the bridge loaded. */
  fullAccess: boolean;
  /** Plan turns block every non-read-only tool without prompting. */
  planMode: boolean;
}

export const AILU_PERMISSION_TITLE_PREFIX = 'AILU_PERMISSION::';
export const AILU_BRIDGE_ACTIVE_NOTIFY = 'AILU_BRIDGE_ACTIVE';

/** Built-in Pi tools that never mutate state and never prompt. */
export const PI_READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;
/** Built-in Pi tools that mutate files or execute commands. */
export const PI_MUTATION_TOOLS = ['bash', 'powershell', 'edit', 'write'] as const;

export interface ParsedPiPermissionRequest {
  tool: string;
  category: string;
  detail: string;
}

/**
 * Generates the Ailu permission-bridge extension for one turn shape.
 *
 * The extension is loaded through the CLI `-e` flag (allowed even when
 * extension discovery is disabled) and intercepts every `tool_call`:
 * read-only built-ins pass silently, mutations and unknown/custom tools ask
 * the host through a blocking `ctx.ui.select` dialog that surfaces in RPC
 * mode as an `extension_ui_request`. The selected option is one of
 * allow-once / allow-turn / deny; deny blocks the call with a reason Pi
 * reports to the model as a tool result so the conversation can continue.
 */
export function piBridgeExtensionSource(config: PiBridgeConfig): string {
  return `// Ailu permission bridge (generated; do not edit).
const CONFIG = { fullAccess: ${config.fullAccess === true}, planMode: ${config.planMode === true} };
const READ_ONLY_TOOLS = ${JSON.stringify([...PI_READ_ONLY_TOOLS])};
const MUTATION_TOOLS = ${JSON.stringify([...PI_MUTATION_TOOLS])};
const DECISIONS = ['allow-once', 'allow-turn', 'deny'];
const TITLE_PREFIX = ${JSON.stringify(AILU_PERMISSION_TITLE_PREFIX)};
const allowedForTurn = new Set();

function summarize(toolName, input) {
  try {
    if (toolName === 'bash' || toolName === 'powershell') {
      return String((input && input.command) || '');
    }
    if (toolName === 'edit' || toolName === 'write' || toolName === 'read' || toolName === 'find') {
      return String((input && input.path) || '');
    }
    return JSON.stringify(input == null ? {} : input).slice(0, 200);
  } catch (error) {
    return '';
  }
}

export default function ailuPermissionBridge(pi) {
  pi.on('session_start', async (_event, ctx) => {
    try {
      ctx.ui.notify(${JSON.stringify(AILU_BRIDGE_ACTIVE_NOTIFY)}, 'info');
    } catch (error) {
      // The host ignores notify failures; loading must never break the turn.
    }
  });

  pi.on('tool_call', async (event, ctx) => {
    const toolName = String(event.toolName || '');
    if (CONFIG.planMode) {
      if (READ_ONLY_TOOLS.includes(toolName)) return;
      return {
        block: true,
        reason: 'Ailu Plan 模式只允许只读操作，已拒绝工具 ' + toolName + '。请继续调研并在最终回复中给出计划。',
      };
    }
    if (CONFIG.fullAccess) return;
    if (READ_ONLY_TOOLS.includes(toolName)) return;
    const category = MUTATION_TOOLS.includes(toolName) ? toolName : 'custom';
    if (allowedForTurn.has(category)) return;
    const payload = {
      tool: toolName,
      category,
      detail: summarize(toolName, event.input),
    };
    let choice;
    try {
      choice = await ctx.ui.select(TITLE_PREFIX + JSON.stringify(payload), DECISIONS);
    } catch (error) {
      choice = undefined;
    }
    if (choice === 'allow-turn') {
      allowedForTurn.add(category);
      return;
    }
    if (choice === 'allow-once') return;
    return {
      block: true,
      reason: '用户拒绝了这次 ' + toolName + ' 调用。请提出替代方案，或等用户调整后重试。',
    };
  });
}
`;
}

function bridgeFileName(source: string): string {
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return `ailu-bridge-${digest}.mjs`;
}

export function piBridgeExtensionDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ailuHome(env), 'pi-extensions');
}

/** Writes (once per config hash) and returns the bridge extension path. */
export function ensurePiBridgeExtension(
  config: PiBridgeConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const source = piBridgeExtensionSource(config);
  const dir = piBridgeExtensionDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, bridgeFileName(source));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, source, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  }
  return filePath;
}

export function parseAiluPermissionRequest(title: unknown): ParsedPiPermissionRequest | null {
  if (typeof title !== 'string' || !title.startsWith(AILU_PERMISSION_TITLE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(title.slice(AILU_PERMISSION_TITLE_PREFIX.length)) as Record<string, unknown>;
    const tool = typeof parsed.tool === 'string' ? parsed.tool : '';
    if (!tool) return null;
    return {
      tool,
      category: typeof parsed.category === 'string' && parsed.category ? parsed.category : 'custom',
      detail: typeof parsed.detail === 'string' ? parsed.detail.slice(0, 400) : '',
    };
  } catch {
    return null;
  }
}
