import { ExportOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Flex, Form, Input, Skeleton, Space, Tabs, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, type OAuthConfig, type OAuthProvider } from '../../api';
import { ProxyField } from '../../components/ProxyField';
import { SettingsPage } from '../../components/SettingsPage';
import { horizontalForm, tip } from '../../lib/form';
import { OAUTH_META, OAUTH_PROVIDERS, useOAuthConfig } from './OAuth';
import { t } from '../../i18n';

type Values = { clientId: string; clientSecret?: string; proxyId: number | null };

function OAuthAppPanel({ provider }: { provider: OAuthProvider }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const meta = OAUTH_META[provider];
  const cfg = useOAuthConfig(provider);
  const [form] = Form.useForm<Values>();
  const [saving, setSaving] = useState(false);
  const redirectUri = cfg.data?.redirectUri;

  // 已保存的密钥显示成首尾几位加星号，没改动就不提交
  useEffect(() => {
    if (cfg.data) form.setFieldsValue({ clientId: cfg.data.clientId, clientSecret: cfg.data.secretHint ?? '', proxyId: cfg.data.proxyId });
  }, [cfg.data, form]);

  const save = async () => {
    const v = await form.validateFields();
    const changed = v.clientSecret && v.clientSecret !== cfg.data?.secretHint;
    setSaving(true);
    try {
      const next = await api<OAuthConfig>(`/api/admin/oauth/${provider}`, {
        method: 'PUT',
        body: { ...v, clientSecret: changed ? v.clientSecret : undefined },
      });
      qc.setQueryData(['oauth', provider], next);
      message.success(t.common.saved);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (cfg.isPending) return <Skeleton active />;

  // 地址跟在步骤文字后面，不单独占一行；窄屏下允许断开
  const redirect = (
    <Typography.Text copyable code style={{ wordBreak: 'break-all' }}>
      {redirectUri ?? '…'}
    </Typography.Text>
  );

  return (
    <div className="oauth-app">
      <div>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          {meta.intro}
          <Typography.Link href={meta.consoleUrl} target="_blank" rel="noopener noreferrer" style={{ marginInlineStart: 4 }}>
            {t.oauthApps.open(meta.consoleName)} <ExportOutlined />
          </Typography.Link>
        </Typography.Paragraph>
        <ol className="oauth-app-steps">
          {meta.steps(redirect).map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        {meta.warning && <Alert type="info" showIcon title={meta.warning} />}
      </div>
      <Form form={form} {...horizontalForm(112)} requiredMark={false} initialValues={{ proxyId: null }}>
        <Form.Item
          name="clientId"
          label={meta.clientIdLabel}
          tooltip={meta.clientIdHint ? tip(meta.clientIdHint) : undefined}
          rules={[{ required: true, message: t.oauthApps.clientIdRequired }]}
        >
          <Input placeholder={meta.clientIdPlaceholder} autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="clientSecret"
          label={provider === 'google' ? t.oauthApps.clientSecretGoogle : t.oauthApps.clientSecretMicrosoft}
          tooltip={tip(t.accountForm.secretTip)}
          rules={cfg.data?.hasSecret ? [] : [{ required: true, message: t.oauthApps.clientSecretRequired }]}
        >
          {/* 还是遮盖值时点进去全选，直接输入就是替换，不会把星号混进新密钥 */}
          <Input allowClear autoComplete="off" spellCheck={false} onFocus={(e) => e.target.value === cfg.data?.secretHint && e.target.select()} />
        </Form.Item>
        <ProxyField help={t.oauthApps.proxyHelp(meta.consoleName.replace(/ .*/, ''))} />
        {redirectUri && !redirectUri.startsWith('https://') && !redirectUri.startsWith('http://localhost') && (
          <Alert type="warning" showIcon title={t.oauthApps.httpsRequired} style={{ marginBottom: 16 }} />
        )}
        <Flex justify="flex-end">
          <Button type="primary" loading={saving} onClick={save}>
            {t.common.save}
          </Button>
        </Flex>
      </Form>
    </div>
  );
}

function TabLabel({ provider }: { provider: OAuthProvider }) {
  const cfg = useOAuthConfig(provider);
  const ready = Boolean(cfg.data?.clientId && cfg.data.hasSecret);
  return (
    <Space size={8}>
      {provider === 'microsoft' ? 'Microsoft' : 'Google'}
      {!cfg.isPending && (
        <Tag color={ready ? 'success' : undefined} style={{ marginInlineEnd: 0 }}>
          {ready ? t.oauthApps.configured : t.oauthApps.notConfigured}
        </Tag>
      )}
    </Space>
  );
}

export function OAuthAppsPage() {
  const navigate = useNavigate();
  // 从添加邮箱里点「去配置」带着 #microsoft / #google 过来，直接打开对应的标签
  const { hash } = useLocation();
  const fromHash = hash.slice(1) as OAuthProvider;
  const active = OAUTH_PROVIDERS.includes(fromHash) ? fromHash : OAUTH_PROVIDERS[0];

  return (
    <SettingsPage title={t.oauthApps.title} description={t.oauthApps.desc}>
      <Tabs
        activeKey={active}
        onChange={(key) => navigate({ hash: key }, { replace: true })}
        items={OAUTH_PROVIDERS.map((p) => ({
          key: p,
          icon: OAUTH_META[p].icon,
          label: <TabLabel provider={p} />,
          children: <OAuthAppPanel provider={p} />,
        }))}
      />
    </SettingsPage>
  );
}
