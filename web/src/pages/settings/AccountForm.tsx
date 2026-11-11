import { ApiOutlined, CheckCircleFilled, InfoCircleOutlined, KeyOutlined, LinkOutlined, MailOutlined, RightOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Checkbox, Flex, Form, Input, InputNumber, Modal, Select, Space, Switch, Typography } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ProxyField } from '../../components/ProxyField';
import { SenderAvatar } from '../../components/SenderAvatar';
import { providerIconDomain } from '../../lib/format';
import { tip } from '../../lib/form';
import { api, type Account, type OAuthProvider, type Provider } from '../../api';
import { OAUTH_META, OAUTH_PROVIDERS, oauthProviderOf, startOAuth, useOAuthConfig } from './OAuth';
import { t } from '../../i18n';

type Values = {
  name: string;
  email: string;
  displayName?: string;
  provider: string;
  username: string;
  secret?: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  syncSinceDays: number;
  // 0 表示用默认间隔，保存时转成 null
  pollIntervalSec: number;
  proxyId: number | null;
};

// 同步间隔可选值（秒）；最短 1 分钟，太频繁容易被邮件服务商限流
const POLL_OPTIONS = [60, 120, 300, 600, 900, 1800, 3600];
/** 同步间隔的文字：整小时显示小时，其余显示分钟 */
export const minutes = (sec: number) => (sec % 3600 === 0 ? t.accountForm.hours(sec / 3600) : t.accountForm.minutes(Math.round(sec / 60)));

type Mode = 'direct' | 'oauth';

// 放在「高级设置」里的字段：校验没通过时自动展开，免得错误提示藏在折叠里
const ADVANCED_FIELDS = ['username', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort', 'syncSinceDays', 'pollIntervalSec'];
const hitsAdvanced = (err: unknown) =>
  !!(err as { errorFields?: Array<{ name: (string | number)[] }> })?.errorFields?.some((f) => ADVANCED_FIELDS.includes(String(f.name[0])));

type SmtpResult = { ok: true } | { ok: false; error: string };
type TestResult =
  { ok: true; graph?: boolean; folders: { path: string }[]; idle: boolean; condstore: boolean; smtp?: SmtpResult } | { ok: false; error: string };

function MethodCard({ active, icon, title, desc, onClick }: { active: boolean; icon: ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={active} className={`choice-card${active ? ' is-active' : ''}`} onClick={onClick}>
      <span className="choice-card-icon">{icon}</span>
      <span style={{ minWidth: 0 }}>
        <Typography.Text strong style={{ display: 'block' }}>
          {title}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {desc}
        </Typography.Text>
      </span>
    </button>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Typography.Text strong className="form-section-title" style={{ display: 'block' }}>
      {children}
    </Typography.Text>
  );
}

function OAuthProviderRow({ provider, onConfigure }: { provider: OAuthProvider; onConfigure: () => void }) {
  const meta = OAUTH_META[provider];
  const cfg = useOAuthConfig(provider);
  const ready = Boolean(cfg.data?.clientId && cfg.data.hasSecret);
  return (
    <div className="oauth-provider">
      <Flex align="center" gap={12}>
        <span className="channel-type-icon" style={{ width: 40, height: 40, fontSize: 20, background: meta.brand }}>
          {meta.icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text strong style={{ display: 'block' }}>
            {meta.account}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {meta.desc}
          </Typography.Text>
        </div>
        <Button type="primary" icon={<LinkOutlined />} disabled={!ready} loading={cfg.isPending} onClick={() => startOAuth(provider)}>
          {t.accountForm.loginAuthorize}
        </Button>
      </Flex>
      {!cfg.isPending && (
        <Flex align="center" gap={8} className="oauth-provider-status">
          {ready ? (
            <>
              <CheckCircleFilled style={{ color: 'var(--ant-color-success)' }} />
              <Typography.Text type="secondary">{t.accountForm.appConfigured(meta.consoleName)}</Typography.Text>
              <Typography.Link onClick={onConfigure}>{t.accountForm.editConfig}</Typography.Link>
            </>
          ) : (
            <>
              <Typography.Text type="warning">{t.accountForm.needApp(meta.consoleName)}</Typography.Text>
              <Typography.Link onClick={onConfigure}>{t.accountForm.configure}</Typography.Link>
            </>
          )}
        </Flex>
      )}
    </div>
  );
}

/** OAuth2 授权：Microsoft（Outlook / Microsoft 365）和 Google（Gmail / Workspace） */
function OAuthPanel({ onConfigure }: { onConfigure: (provider: OAuthProvider) => void }) {
  return (
    <>
      <SectionTitle>{t.accountForm.pickAccountType}</SectionTitle>
      <Flex vertical gap={10}>
        {OAUTH_PROVIDERS.map((p) => (
          <OAuthProviderRow key={p} provider={p} onConfigure={() => onConfigure(p)} />
        ))}
      </Flex>
      <ol className="channel-steps" style={{ marginTop: 16, marginBottom: 0 }}>
        {t.accountForm.oauthSteps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '12px 2px 0' }}>
        {t.accountForm.oauthOthers}
      </Typography.Paragraph>
    </>
  );
}

/** 服务器上配置的默认同步间隔（没给邮箱单独设置时用它） */
export const useSyncDefaults = () =>
  useQuery({
    queryKey: ['sync-defaults'],
    queryFn: () => api<{ pollIntervalSec: number }>('/api/admin/sync-defaults'),
    staleTime: Infinity,
  });

export function AccountForm({ open, account, onClose }: { open: boolean; account: Account | null; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form] = Form.useForm<Values>();
  const [mode, setMode] = useState<Mode>('direct');
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<Provider[]>('/api/admin/providers') });
  const defaultPoll = useSyncDefaults().data?.pollIntervalSec;
  const providerId = Form.useWatch('provider', form);
  const email = Form.useWatch('email', form) ?? '';
  const provider = providers.data?.find((p) => p.id === providerId);
  // 直连能用的服务商；只能 OAuth 的（Outlook）放在 OAuth2 里
  const directProviders = providers.data?.filter((p) => !p.requiresOAuth) ?? [];
  const isOAuth = account?.authType === 'oauth2';
  const isGraph = account?.protocol === 'graph';
  const domain = email.split('@')[1]?.toLowerCase();
  const needsOAuth = !account && !!domain && !!providers.data?.some((p) => p.requiresOAuth && p.domains.includes(domain));
  // 用户名、显示名称是根据邮箱自动填的，邮箱改了就跟着改；用户自己改过的不动
  const autoFilled = useRef('');

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setMode('direct');
    setAdvanced(false);
    autoFilled.current = '';
    form.resetFields();
    if (account)
      form.setFieldsValue({
        ...account,
        displayName: account.displayName ?? undefined,
        smtpHost: account.smtpHost ?? undefined,
        smtpPort: account.smtpPort ?? undefined,
        smtpSecure: account.smtpSecure ?? undefined,
        pollIntervalSec: account.pollIntervalSec ?? 0,
      });
  }, [open, account, form]);

  const applyProvider = (id: string) => {
    const p = providers.data?.find((x) => x.id === id);
    if (!p) return;
    setResult(null);
    form.setFieldsValue({
      provider: p.id,
      imapHost: p.imap.host,
      imapPort: p.imap.port,
      imapSecure: p.imap.secure,
      smtpHost: p.smtp.host,
      smtpPort: p.smtp.port,
      smtpSecure: p.smtp.secure,
    });
  };

  // 输入邮箱后自动识别服务商、填充用户名和显示名称
  const onEmailBlur = () => {
    const value: string = (form.getFieldValue('email') ?? '').trim();
    const d = value.split('@')[1]?.toLowerCase();
    if (!d) return;
    for (const field of ['username', 'name'] as const) {
      const cur = form.getFieldValue(field);
      if (!cur || cur === autoFilled.current) form.setFieldValue(field, value);
    }
    autoFilled.current = value;
    const match = directProviders.find((p) => p.domains.includes(d));
    if (match && !account) applyProvider(match.id);
  };

  const test = async () => {
    let values: Partial<Values>;
    try {
      values = await form.validateFields(['email', 'imapHost', 'imapPort', 'username', ...(account ? [] : ['secret'])]);
    } catch (err) {
      if (hitsAdvanced(err)) setAdvanced(true);
      return;
    }
    setTesting(true);
    setResult(null);
    try {
      const all = form.getFieldsValue(true);
      setResult(await api<TestResult>('/api/admin/accounts/test', { method: 'POST', body: { ...all, ...values, id: account?.id } }));
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    let validated: Values;
    try {
      validated = await form.validateFields();
    } catch (err) {
      if (hitsAdvanced(err)) setAdvanced(true);
      return;
    }
    // 隐藏的字段（Graph 账户的服务器设置等）validateFields 不一定返回，从 store 里补齐
    const values = { ...(form.getFieldsValue(true) as Values), ...validated };
    setSaving(true);
    try {
      const body = { ...values, secret: values.secret || undefined, pollIntervalSec: values.pollIntervalSec || null };
      if (account) await api(`/api/admin/accounts/${account.id}`, { method: 'PATCH', body });
      else await api('/api/admin/accounts', { method: 'POST', body });
      message.success(account ? t.accountForm.savedReconnecting : t.accountForm.addedSyncing);
      await qc.invalidateQueries({ queryKey: ['accounts'] });
      await qc.invalidateQueries({ queryKey: ['admin-accounts'] });
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const direct = account ? !isOAuth : mode === 'direct';
  const secretLabel = provider?.secretLabel ?? t.accountForm.password;

  return (
    <Modal
      open={open}
      title={account ? t.accountForm.editTitle(account.email) : t.accountForm.addTitle}
      onCancel={onClose}
      width={720}
      destroyOnHidden
      styles={{ body: { maxHeight: 'calc(100vh - 240px)', overflow: 'auto', marginInline: -24, paddingInline: 24 } }}
      footer={
        direct || isOAuth ? (
          <Flex justify="space-between" gap={8}>
            {direct ? (
              <Button icon={<ApiOutlined />} loading={testing} onClick={test}>
                {t.accountForm.testConnection}
              </Button>
            ) : (
              <span />
            )}
            <Space>
              <Button onClick={onClose}>{t.common.cancel}</Button>
              <Button type="primary" loading={saving} onClick={save}>
                {account ? t.common.save : t.accountForm.add}
              </Button>
            </Space>
          </Flex>
        ) : (
          <Button onClick={onClose}>{t.common.cancel}</Button>
        )
      }
    >
      {!account && (
        <div className="choice-cards" role="radiogroup" aria-label={t.accountForm.method}>
          <MethodCard
            active={mode === 'direct'}
            icon={<KeyOutlined />}
            title={t.accountForm.direct}
            desc={t.accountForm.directDesc}
            onClick={() => setMode('direct')}
          />
          <MethodCard
            active={mode === 'oauth'}
            icon={<LinkOutlined />}
            title={t.accountForm.oauth}
            desc={t.accountForm.oauthDesc}
            onClick={() => setMode('oauth')}
          />
        </div>
      )}

      {!account && mode === 'oauth' && <OAuthPanel onConfigure={(p) => navigate(`/settings/oauth#${p}`)} />}
      {/* 切到 OAuth2 时表单只隐藏不卸载，切回来填过的内容还在 */}
      <div style={{ display: direct || isOAuth ? undefined : 'none' }}>
        <Form
          form={form}
          layout="vertical"
          className="account-form"
          requiredMark={false}
          initialValues={{
            provider: 'qq',
            imapHost: 'imap.qq.com',
            imapPort: 993,
            imapSecure: true,
            smtpHost: 'smtp.qq.com',
            smtpPort: 465,
            smtpSecure: true,
            syncSinceDays: 90,
            pollIntervalSec: 0,
            proxyId: null,
          }}
        >
          <Form.Item name="provider" hidden>
            <Input />
          </Form.Item>

          {!account && (
            <Form.Item label={t.accountForm.provider}>
              <div className="provider-grid" role="radiogroup" aria-label={t.accountForm.provider}>
                {directProviders.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={p.id === providerId}
                    title={p.name}
                    className={`provider-tile${p.id === providerId ? ' is-active' : ''}`}
                    onClick={() => applyProvider(p.id)}
                  >
                    {providerIconDomain(p.id) ? (
                      <SenderAvatar address={null} name={p.name} size={18} iconDomain={providerIconDomain(p.id)} />
                    ) : (
                      <MailOutlined className="provider-tile-icon" />
                    )}
                    <span className="provider-tile-name">{p.name}</span>
                  </button>
                ))}
              </div>
            </Form.Item>
          )}

          {provider && !isOAuth && (
            <div className="provider-help">
              <InfoCircleOutlined />
              <span>
                {/* 编辑时没有服务商选择，在说明前标出是哪家 */}
                {account && <b>{t.accountForm.providerPrefix(provider.name)}</b>}
                {provider.help}
              </span>
            </div>
          )}
          {isOAuth && (
            <Alert
              type="success"
              showIcon
              title={t.accountForm.oauthConnected(OAUTH_META[oauthProviderOf(account!)].account)}
              description={t.accountForm.oauthConnectedDesc}
              style={{ marginBottom: 16 }}
            />
          )}

          <div className="form-row">
            <Form.Item name="email" label={t.accountForm.email} rules={[{ required: true, type: 'email', message: t.accountForm.emailInvalid }]}>
              <Input placeholder="name@example.com" onBlur={onEmailBlur} autoComplete="off" disabled={isOAuth} />
            </Form.Item>
            {!isOAuth && (
              <Form.Item
                name="secret"
                label={secretLabel}
                rules={account ? [] : [{ required: true, message: t.accountForm.secretRequired(secretLabel) }]}
                tooltip={tip(t.accountForm.secretTip)}
              >
                <Input.Password autoComplete="new-password" placeholder={account ? t.accountForm.keepSecret : undefined} />
              </Form.Item>
            )}
          </div>
          {needsOAuth && (
            <Alert
              type="warning"
              showIcon
              title={t.accountForm.microsoftNeedsOAuth}
              action={
                <Button size="small" onClick={() => setMode('oauth')}>
                  {t.accountForm.useOAuth}
                </Button>
              }
              style={{ marginTop: -4, marginBottom: 16 }}
            />
          )}
          <div className="form-row">
            <Form.Item
              name="name"
              label={t.accountForm.name}
              rules={[{ required: true, message: t.accountForm.nameRequired }]}
              tooltip={tip(t.accountForm.nameTip)}
            >
              <Input placeholder={t.accountForm.namePlaceholder} />
            </Form.Item>
            <Form.Item name="displayName" label={t.accountForm.senderName} tooltip={tip(t.accountForm.senderNameTip)}>
              <Input placeholder={t.accountForm.senderNamePlaceholder} />
            </Form.Item>
          </div>

          <ProxyField help={t.accountForm.proxyHelp} />

          <button type="button" className="form-advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
            <RightOutlined className="form-advanced-caret" />
            {t.accountForm.advanced}
            <span className="form-advanced-hint">{isGraph ? t.accountForm.advancedHintGraph : t.accountForm.advancedHint}</span>
          </button>
          {/* 收起时只隐藏不卸载，字段值和校验都还在 */}
          <div className="form-advanced-body" hidden={!advanced}>
            <Form.Item
              name="username"
              label={t.accountForm.username}
              rules={[{ required: true, message: t.accountForm.usernameRequired }]}
              tooltip={tip(t.accountForm.usernameTip)}
            >
              <Input autoComplete="off" disabled={isOAuth} />
            </Form.Item>
            {/* Graph 账户不用 IMAP/SMTP，服务器字段仍保留在表单里（隐藏），保存时原样带回 */}
            <Form.Item label={t.accountForm.imap} tooltip={tip(t.accountForm.imapTip)} hidden={isGraph}>
              <Flex gap={8} align="center">
                <Form.Item name="imapHost" noStyle rules={[{ required: true, message: t.accountForm.imapHostRequired }]}>
                  <Input placeholder="imap.example.com" />
                </Form.Item>
                <Form.Item name="imapPort" noStyle rules={[{ required: true, message: t.accountForm.imapPortRequired }]}>
                  <InputNumber min={1} max={65535} placeholder={t.accountForm.port} style={{ width: 96, flex: 'none' }} />
                </Form.Item>
                <Form.Item name="imapSecure" valuePropName="checked" noStyle>
                  <Checkbox style={{ flex: 'none' }}>SSL/TLS</Checkbox>
                </Form.Item>
              </Flex>
            </Form.Item>
            <Form.Item label={t.accountForm.smtp} tooltip={tip(t.accountForm.smtpTip)} hidden={isGraph}>
              <Flex gap={8} align="center">
                <Form.Item name="smtpHost" noStyle>
                  <Input placeholder="smtp.example.com" />
                </Form.Item>
                <Form.Item name="smtpPort" noStyle>
                  <InputNumber min={1} max={65535} placeholder={t.accountForm.port} style={{ width: 96, flex: 'none' }} />
                </Form.Item>
                <Form.Item name="smtpSecure" valuePropName="checked" noStyle>
                  <Checkbox style={{ flex: 'none' }}>SSL/TLS</Checkbox>
                </Form.Item>
              </Flex>
            </Form.Item>
            <div className="form-row">
              <Form.Item name="syncSinceDays" label={t.accountForm.firstSync} tooltip={tip(t.accountForm.firstSyncTip)}>
                <InputNumber min={1} max={3650} prefix={t.accountForm.recent} suffix={t.accountForm.daysOfMail} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="pollIntervalSec" label={t.accountForm.pollInterval} tooltip={tip(isGraph ? t.accountForm.pollTipGraph : t.accountForm.pollTip)}>
                <Select
                  options={[
                    { value: 0, label: defaultPoll ? t.accountForm.defaultEvery(minutes(defaultPoll)) : t.accountForm.default },
                    ...POLL_OPTIONS.map((v) => ({ value: v, label: t.accountForm.every(minutes(v)) })),
                  ]}
                />
              </Form.Item>
            </div>
          </div>

          {result &&
            (result.ok ? (
              <Flex vertical gap={8} style={{ marginTop: 16 }}>
                <Alert
                  type="success"
                  showIcon
                  title={result.graph ? t.accountForm.graphOk(result.folders.length) : t.accountForm.imapOk(result.folders.length, result.idle)}
                />
                {result.smtp && (
                  <Alert
                    type={result.smtp.ok ? 'success' : 'warning'}
                    showIcon
                    title={result.smtp.ok ? t.accountForm.smtpOk : t.accountForm.smtpFailed(result.smtp.error)}
                  />
                )}
              </Flex>
            ) : (
              <Alert type="error" showIcon title={t.accountForm.connectFailed} description={result.error} style={{ marginTop: 16 }} />
            ))}
        </Form>
      </div>
    </Modal>
  );
}
