import { t } from '../i18n/index.js';

/** 审计日志里动作的名称（按当前请求的语言）：业务动作、通用请求（METHOD + 路由）；MCP 工具名由调用方传入工具标题 */
export function actionLabel(action: string, target: string | null, toolTitle?: (name: string) => string | undefined) {
  if (action === 'mcp.call' && target) return toolTitle?.(target) ?? target;
  const actions = t().audit.actions;
  return actions[action] ?? actions[action.replace(/\/$/, '')] ?? null;
}
