import { useQuery } from '@tanstack/react-query';
import { KeyOutlined, RightOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Descriptions, Flex, Tag, Tooltip, Typography, theme } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import { api, type McpOAuthInfo } from '../../api';
import { SettingsPage } from '../../components/SettingsPage';
import { t } from '../../i18n';

const origin = window.location.origin;

/** 权限的简短名字，按当前界面语言取 */
export const scopeLabel = (scope: string) => t.openApi.scopeLabel[scope] ?? scope;
export const SCOPE_COLOR: Record<string, string> = { organize: 'blue', draft: 'gold', send: 'red', automation: 'purple' };

const SCOPE_ORDER = ['read', 'organize', 'draft', 'send', 'automation'];

type McpTool = { name: string; title: string; description: string; scope: string };

/** 按所需权限分组列出 MCP 工具，悬停看说明 */
function ToolList() {
  const tools = useQuery({ queryKey: ['mcp-tools'], queryFn: () => api<McpTool[]>('/api/admin/mcp-tools'), staleTime: Infinity });
  if (tools.isPending) return <Typography.Text type="secondary">{t.openApi.loading}</Typography.Text>;
  if (!tools.data) return <Typography.Text type="danger">{(tools.error as Error | null)?.message ?? t.openApi.loadFailed}</Typography.Text>;
  return (
    <Flex vertical gap={8}>
      {SCOPE_ORDER.map((scope) => {
        const list = tools.data.filter((tool) => tool.scope === scope);
        if (!list.length) return null;
        return (
          <Flex key={scope} gap={8} align="baseline">
            <Typography.Text type="secondary" style={{ flex: 'none', width: 36 }}>
              {scopeLabel(scope)}
            </Typography.Text>
            <Flex wrap gap={4}>
              {list.map((tool) => (
                <Tooltip
                  key={tool.name}
                  title={
                    <>
                      <b>{tool.title}</b>
                      <br />
                      {tool.description}
                    </>
                  }
                >
                  <Tag color={SCOPE_COLOR[scope]} style={{ marginInlineEnd: 0, cursor: 'help' }}>
                    {tool.name}
                  </Tag>
                </Tooltip>
              ))}
            </Flex>
          </Flex>
        );
      })}
    </Flex>
  );
}

/** 代码块：复制按钮在右下角，只有一行时跟在末尾 */
function CodeBlock({ code }: { code: string }) {
  const { token } = theme.useToken();
  const multiline = code.includes('\n');
  const box: CSSProperties = {
    position: 'relative',
    margin: 0,
    padding: multiline ? '8px 40px 8px 12px' : '8px 12px',
    background: token.colorFillTertiary,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadius,
    fontFamily: token.fontFamilyCode,
    fontSize: 12,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  };
  if (!multiline) {
    return (
      <Typography.Paragraph copyable={{ text: code }} style={box}>
        {code}
      </Typography.Paragraph>
    );
  }
  return (
    <div style={box}>
      {code}
      <Typography.Text copyable={{ text: code }} style={{ position: 'absolute', right: 10, bottom: 6 }} />
    </div>
  );
}

export function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>
        {title}
      </Typography.Text>
      <CodeBlock code={code} />
    </div>
  );
}

export function snippets(key: string) {
  return {
    claudeCode: `claude mcp add --transport http damail ${origin}/mcp --header "Authorization: Bearer ${key}"`,
    json: JSON.stringify({ mcpServers: { damail: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
    curl: `curl -H "Authorization: Bearer ${key}" "${origin}/api/v1/messages?q=is:unread"`,
  };
}

type AuthMethod = {
  key: string;
  icon: ReactNode;
  tone: 'blue' | 'green';
  title: string;
  apis: string[];
  how: string;
  clients: string;
  link: { to: string; label: string };
  status?: ReactNode;
};

/** 两种认证方式并排成两张卡片：能访问哪些接口、怎么用、适合哪些客户端，底部是管理入口 */
function AuthMethods() {
  const { token } = theme.useToken();
  const oauth = useQuery({ queryKey: ['mcp-oauth'], queryFn: () => api<McpOAuthInfo>('/api/admin/mcp-oauth') });
  const methods: AuthMethod[] = [
    {
      key: 'key',
      icon: <KeyOutlined />,
      tone: 'blue',
      title: 'API Key',
      apis: ['MCP', 'REST API'],
      how: t.openApi.keyHow,
      clients: t.openApi.keyClients,
      link: { to: '/settings/api', label: t.openApi.manageKeys },
    },
    {
      key: 'oauth',
      icon: <SafetyCertificateOutlined />,
      tone: 'green',
      title: 'OAuth',
      apis: ['MCP'],
      how: t.openApi.oauthHow,
      clients: t.openApi.oauthClients,
      link: { to: '/settings/mcp-oauth', label: t.openApi.oauthSettings },
      status: oauth.data && !oauth.data.enabled && <Tag style={{ marginInlineEnd: 0 }}>{t.openApi.disabled}</Tag>,
    },
  ];
  const tones = { blue: [token.blue1, token.blue6], green: [token.green1, token.green6] };
  return (
    <div className="auth-methods">
      {methods.map((m) => (
        <div key={m.key} className="auth-method">
          <Flex align="center" gap={10}>
            <span className="pref-icon" style={{ background: tones[m.tone][0], color: tones[m.tone][1] }}>
              {m.icon}
            </span>
            <span className="pref-title">{m.title}</span>
            <Flex gap={4} style={{ marginInlineStart: 'auto' }}>
              {m.status}
              {m.apis.map((a) => (
                <Tag key={a} bordered={false} style={{ marginInlineEnd: 0 }}>
                  {a}
                </Tag>
              ))}
            </Flex>
          </Flex>
          <div className="auth-method-how">{m.how}</div>
          <div className="pref-desc">{t.openApi.suitedFor(m.clients)}</div>
          <Link to={m.link.to} className="auth-method-link">
            {m.link.label}
            <RightOutlined />
          </Link>
        </div>
      ))}
    </div>
  );
}

/** 接入方式：MCP / REST 地址、两种认证方式、可用工具和配置示例 */
export function McpConnectPage() {
  const example = snippets(t.openApi.yourKey);
  return (
    <SettingsPage title={t.openApi.connectTitle} description={t.openApi.connectDesc}>
      <Descriptions
        column={1}
        size="small"
        style={{ marginBottom: 24, maxWidth: 960 }}
        // 标签统一宽度，右边的内容对齐成一列
        styles={{ label: { width: 80, flex: 'none' } }}
        items={[
          { label: t.openApi.mcpUrl, children: <Typography.Text copyable code>{`${origin}/mcp`}</Typography.Text> },
          { label: t.openApi.mcpTransport, children: 'Streamable HTTP' },
          { label: 'REST API', children: <Typography.Text code>{`${origin}/api/v1`}</Typography.Text> },
          // 标签文字和卡片标题对齐（卡片内边距 + 图标高度带来的偏移）
          { label: t.openApi.auth, children: <AuthMethods />, styles: { label: { paddingTop: 21 } } },
          { label: t.openApi.mcpTools, children: <ToolList /> },
        ]}
      />
      <div style={{ maxWidth: 960 }}>
        <Snippet title="Claude Code" code={example.claudeCode} />
        <Snippet title={t.openApi.jsonClients} code={example.json} />
        <Snippet title={t.openApi.restExample} code={example.curl} />
      </div>
    </SettingsPage>
  );
}
