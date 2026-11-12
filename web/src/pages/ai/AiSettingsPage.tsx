import {
  ApiOutlined,
  CloudSyncOutlined,
  DeleteOutlined,
  DollarOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlusOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  AutoComplete,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { api, type AiChannel, type AiChannelStatus, type AiEffort, type AiProvider, type AiSettings, type Insight, type ModelPrice } from '../../api';
import { InsightCard } from '../../components/Insight';
import { fromNow } from '../../lib/format';
import { horizontalForm, tip } from '../../lib/form';
import { t } from '../../i18n';

type Which = 'default' | 'assistant' | 'translate';

type FormValues = {
  enabled: boolean;
  channelId: string;
  model: string;
  effort: AiEffort;
  // '' 表示跟随默认渠道
  assistantChannelId: string;
  assistantModel?: string;
  // '' 表示服务商默认
  assistantEffort: AiEffort | '';
  // '' 表示跟随默认渠道
  translateChannelId: string;
  translateModel?: string;
  translateLanguage: string;
};

const TRANSLATE_LANGUAGES = ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский'];

// 页面上编辑中的渠道；apiKey 不传表示不修改，'' 表示清除
type ChannelDraft = AiChannel & { apiKey?: string };

type ChannelForm = {
  name?: string;
  provider: AiProvider;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
  prices?: Record<string, Partial<ModelPrice>>;
  priceRate?: number;
  concurrency?: number | null;
};

/** 并发限制的预设值 */
const CONCURRENCY_PRESETS = [1, 2, 3, 5, 10];

/** 渠道状态：限流暂停中（倒计时）/ 请求进行中、排队 / 正常；悬停看最近一次限流 */
function ChannelState({ s }: { s: AiChannelStatus | undefined }) {
  const [, setNow] = useState(0);
  const paused = s?.pausedUntil ? Math.ceil((new Date(s.pausedUntil).getTime() - Date.now()) / 1000) : 0;
  const pausing = paused > 0;
  // 暂停中每秒刷新倒计时
  useEffect(() => {
    if (!pausing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pausing]);
  const history = s?.limitedAt ? t.aiSettings.limitedHistory(fromNow(s.limitedAt), s.limitedCount) : undefined;
  let badge;
  if (paused > 0) badge = <Badge status="warning" text={t.aiSettings.statusPaused(paused)} />;
  else if (s && (s.active || s.waiting)) badge = <Badge status="processing" text={t.aiSettings.statusBusy(s.active, s.waiting)} />;
  else badge = <Badge status="success" text={t.aiSettings.statusOk} />;
  return (
    <Flex vertical>
      <Tooltip title={history}>{badge}</Tooltip>
      {s?.waiting && paused > 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t.aiSettings.statusQueued(s.waiting)}
        </Typography.Text>
      ) : null}
      {history && paused <= 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t.aiSettings.limitedAgo(fromNow(s!.limitedAt!))}
        </Typography.Text>
      )}
    </Flex>
  );
}

const providerLabel = (p: AiProvider) => (p === 'anthropic' ? 'Anthropic' : t.aiSettings.openaiCompat);

const newId = () => Math.random().toString(36).slice(2, 10);

const toChannelInput = ({ hasApiKey: _h, apiKeyHint: _k, ...ch }: ChannelDraft) => ch;

// 说明按当前界面语言从 t.aiSettings.claudeHints 取
const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

// OpenAI 兼容接口的 reasoning_effort 一般只认 low / medium / high
const effortOptions = (provider: AiProvider) =>
  (provider === 'anthropic' ? (['low', 'medium', 'high', 'xhigh', 'max'] as const) : (['low', 'medium', 'high'] as const)).map((v) => ({
    value: v,
    label: t.assistant.effort[v as AiEffort],
  }));

function SyncModelsModal({
  upstream,
  current,
  onCancel,
  onOk,
}: {
  upstream: string[];
  current: string[];
  onCancel: () => void;
  onOk: (models: string[]) => void;
}) {
  // 默认保留已有且上游仍存在的模型；原来是空的就全选
  const [picked, setPicked] = useState(() => {
    const kept = current.filter((m) => upstream.includes(m));
    return kept.length ? kept : upstream;
  });
  const [keyword, setKeyword] = useState('');
  const shown = upstream.filter((m) => m.toLowerCase().includes(keyword.trim().toLowerCase()));

  return (
    <Modal
      open
      title={t.aiSettings.upstreamCount(upstream.length)}
      okText={t.aiSettings.keepN(picked.length)}
      okButtonProps={{ disabled: !picked.length }}
      onCancel={onCancel}
      onOk={() => onOk(picked)}
      width={560}
    >
      <Typography.Paragraph type="secondary">{t.aiSettings.pickModels}</Typography.Paragraph>
      <Flex gap={8} style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder={t.aiSettings.searchModels} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <Button onClick={() => setPicked([...new Set([...picked, ...shown])])}>{t.aiSettings.selectAll(!!keyword)}</Button>
        <Button onClick={() => setPicked(picked.filter((m) => !shown.includes(m)))}>{t.aiSettings.clearAll(!!keyword)}</Button>
      </Flex>
      <div style={{ maxHeight: 360, overflow: 'auto' }}>
        {shown.length ? (
          <Checkbox.Group value={picked} onChange={(v) => setPicked(v as string[])} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {shown.map((m) => (
              <Checkbox key={m} value={m}>
                <Typography.Text style={{ fontFamily: 'var(--ant-font-family-code)' }}>{m}</Typography.Text>
              </Checkbox>
            ))}
          </Checkbox.Group>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t.aiSettings.noMatch} />
        )}
      </div>
    </Modal>
  );
}

function ChannelModal({ channel, onCancel, onOk }: { channel: ChannelDraft; onCancel: () => void; onOk: (ch: ChannelDraft) => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<ChannelForm>();
  const provider = Form.useWatch('provider', form) ?? channel.provider;
  const models = Form.useWatch('models', form);
  const [filling, setFilling] = useState(false);
  const [clearKey, setClearKey] = useState(channel.apiKey === '');
  const [syncedAt, setSyncedAt] = useState(channel.modelsSyncedAt);
  const [syncing, setSyncing] = useState(false);
  const [upstream, setUpstream] = useState<{ models: string[]; syncedAt: string } | null>(null);

  const draft = (): ChannelDraft => {
    const v = form.getFieldsValue(true) as ChannelForm;
    // 只保留列表里还有、输入和输出单价都填了的模型
    const prices: Record<string, ModelPrice> = {};
    for (const m of v.models ?? []) {
      const p = v.prices?.[m];
      if (typeof p?.input === 'number' && typeof p.output === 'number')
        prices[m] = { input: p.input, output: p.output, cacheRead: p.cacheRead ?? null, cacheWrite: p.cacheWrite ?? null };
    }
    return {
      ...channel,
      name: v.name?.trim() ?? '',
      provider: v.provider,
      baseUrl: v.baseUrl?.trim() || null,
      models: v.models ?? [],
      modelsSyncedAt: syncedAt,
      prices,
      priceRate: v.priceRate ?? 1,
      concurrency: v.concurrency || null,
      // 输入框里还是遮盖值表示没改
      apiKey: (v.apiKey?.trim() !== channel.apiKeyHint && v.apiKey?.trim()) || (clearKey ? '' : undefined),
    };
  };

  // 从公开价格表带出官方单价，只填还没设置价格的模型
  const fillPrices = async () => {
    const list = (form.getFieldValue('models') as string[] | undefined) ?? [];
    if (!list.length) return message.warning(t.aiSettings.addModelsFirst);
    setFilling(true);
    try {
      const res = await api<{ prices: Record<string, ModelPrice> }>('/api/admin/ai/prices/reference', { method: 'POST', body: { models: list } });
      let filled = 0;
      for (const [m, p] of Object.entries(res.prices)) {
        if (typeof form.getFieldValue(['prices', m, 'input']) === 'number') continue;
        form.setFieldValue(['prices', m], p);
        filled++;
      }
      const missing = list.filter((m) => !res.prices[m]).length;
      message.success(t.aiSettings.filled(filled, missing));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setFilling(false);
    }
  };

  const syncModels = async () => {
    await form.validateFields(['name', 'baseUrl']);
    setSyncing(true);
    try {
      setUpstream(
        await api<{ models: string[]; syncedAt: string }>('/api/admin/ai/models/sync', { method: 'POST', body: { channel: toChannelInput(draft()) } }),
      );
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Modal
      open
      title={channel.name ? t.aiSettings.editChannel(channel.name) : t.aiSettings.addChannel}
      okText={t.aiSettings.ok}
      width={760}
      onCancel={onCancel}
      onOk={async () => {
        await form.validateFields();
        onOk(draft());
      }}
    >
      <Form
        form={form}
        {...horizontalForm()}
        requiredMark={false}
        initialValues={{
          name: channel.name,
          provider: channel.provider,
          baseUrl: channel.baseUrl ?? '',
          // 已保存的 Key 显示成首尾几位加星号
          apiKey: channel.apiKey ?? (channel.hasApiKey ? (channel.apiKeyHint ?? undefined) : undefined),
          models: channel.models,
          prices: channel.prices,
          priceRate: channel.priceRate,
          concurrency: channel.concurrency ?? null,
        }}
      >
        <Form.Item name="name" label={t.aiSettings.name} rules={[{ required: true, whitespace: true, message: t.aiSettings.nameRequired }]}>
          <Input placeholder={t.aiSettings.namePlaceholder} maxLength={100} />
        </Form.Item>
        <Form.Item name="provider" label={t.aiSettings.provider}>
          <Segmented
            options={[
              { value: 'anthropic', label: 'Anthropic Claude' },
              { value: 'openai', label: t.aiSettings.openaiCompatApi },
            ]}
            onChange={(v) => {
              // 换服务商后原来的模型列表多半不通用
              if (v !== channel.provider) form.setFieldValue('models', []);
              else form.setFieldValue('models', channel.models);
              setSyncedAt(v !== channel.provider ? null : channel.modelsSyncedAt);
            }}
          />
        </Form.Item>
        <Form.Item
          name="baseUrl"
          label="Base URL"
          extra={provider === 'anthropic' ? t.aiSettings.baseUrlAnthropic : t.aiSettings.baseUrlOpenai}
          rules={[{ required: provider === 'openai', message: t.aiSettings.baseUrlRequired }]}
        >
          <Input placeholder={provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.example.com/v1'} />
        </Form.Item>
        <Form.Item label="API Key" tooltip={tip(t.aiSettings.keyTip)}>
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item name="apiKey" noStyle>
              <Input
                placeholder={clearKey ? t.aiSettings.keyWillClear : provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                autoComplete="off"
                spellCheck={false}
                // 还是遮盖值时点进去全选，直接输入就是替换
                onFocus={(e) => e.target.value === channel.apiKeyHint && e.target.select()}
              />
            </Form.Item>
            {channel.hasApiKey && (
              <Button
                danger={!clearKey}
                onClick={() => {
                  form.setFieldValue('apiKey', clearKey ? (channel.apiKeyHint ?? undefined) : undefined);
                  setClearKey(!clearKey);
                }}
              >
                {clearKey ? t.aiSettings.undoClear : t.aiSettings.clear}
              </Button>
            )}
          </Space.Compact>
        </Form.Item>
        <Form.Item
          label={t.aiSettings.models}
          extra={models?.length ? t.aiSettings.modelsSummary(models.length, syncedAt ? fromNow(syncedAt) : null) : t.aiSettings.modelsEmpty}
        >
          <Flex gap={8}>
            <Form.Item name="models" noStyle>
              <Select mode="tags" maxTagCount="responsive" placeholder={t.aiSettings.noModels} tokenSeparators={[',', ' ']} open={false} suffixIcon={null} />
            </Form.Item>
            <Button icon={<CloudSyncOutlined />} loading={syncing} onClick={syncModels}>
              {t.aiSettings.syncUpstream}
            </Button>
          </Flex>
        </Form.Item>
        <Form.Item
          name="concurrency"
          label={t.aiSettings.concurrency}
          extra={t.aiSettings.concurrencyExtra}
          // 分段控制器不收 null：「默认」用 0 表示，保存时再转回 null
          getValueProps={(v: number | null | undefined) => ({ value: v || 0 })}
          normalize={(v: number) => v || null}
        >
          <Segmented
            options={[
              { value: 0, label: t.aiSettings.unlimited },
              // 以前保存过不在预设里的值，也要能选中
              ...[...new Set([...CONCURRENCY_PRESETS, ...(channel.concurrency ? [channel.concurrency] : [])])]
                .sort((x, y) => x - y)
                .map((n) => ({ value: n, label: String(n) })),
            ]}
          />
        </Form.Item>
        <Form.Item label={t.aiSettings.prices} extra={t.aiSettings.pricesExtra} style={{ marginBottom: 0 }}>
          <Flex gap={8} align="center" style={{ marginBottom: 8 }}>
            <Typography.Text>{t.aiSettings.rate}</Typography.Text>
            <Form.Item name="priceRate" noStyle>
              <InputNumber min={0} max={100} step={0.1} style={{ width: 100 }} />
            </Form.Item>
            <Button icon={<DollarOutlined />} loading={filling} onClick={fillPrices}>
              {t.aiSettings.fillPrices}
            </Button>
          </Flex>
          <Table<string>
            size="small"
            bordered
            rowKey={(m) => m}
            pagination={false}
            dataSource={models ?? []}
            scroll={{ y: 240 }}
            locale={{ emptyText: t.aiSettings.addModelsFirst }}
            columns={[
              { title: t.aiSettings.model, key: 'model', ellipsis: true, render: (_, m) => m },
              ...(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((f) => ({
                title: t.aiSettings.priceCols[f],
                key: f,
                width: 100,
                render: (_: unknown, m: string) => (
                  <Form.Item name={['prices', m, f]} noStyle>
                    <InputNumber size="small" min={0} controls={false} placeholder="-" style={{ width: '100%' }} />
                  </Form.Item>
                ),
              })),
            ]}
          />
        </Form.Item>
      </Form>

      {upstream && (
        <SyncModelsModal
          upstream={upstream.models}
          current={models ?? []}
          onCancel={() => setUpstream(null)}
          onOk={(picked) => {
            form.setFieldValue('models', picked);
            setSyncedAt(upstream.syncedAt);
            setUpstream(null);
          }}
        />
      )}
    </Modal>
  );
}

export function AiSettingsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['ai-settings'], queryFn: () => api<AiSettings>('/api/admin/ai') });
  // 渠道的并发和限流状态，定时刷新
  const channelStatus = useQuery({
    queryKey: ['ai-channel-status'],
    queryFn: () => api<Record<string, AiChannelStatus>>('/api/admin/ai/channels/status'),
    refetchInterval: 5000,
  });
  const [form] = Form.useForm<FormValues>();
  // 请求、统计原来是这个页面的标签，旧链接 ?tab=requests / ?tab=stats 跳到各自的页面
  const [params] = useSearchParams();
  const oldTab = params.get('tab');
  const channelId = Form.useWatch('channelId', form);
  const assistantChannelId = Form.useWatch('assistantChannelId', form);
  const translateChannelId = Form.useWatch('translateChannelId', form);
  const defaultModel = Form.useWatch('model', form);
  const [channels, setChannels] = useState<ChannelDraft[]>([]);
  const [editing, setEditing] = useState<ChannelDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<Which | null>(null);
  const [test, setTest] = useState<{ ok: boolean; model: string; error?: string; ms?: number; insight?: Insight } | null>(null);

  const defaultChannel = channels.find((c) => c.id === channelId);
  const followsDefault = !assistantChannelId || assistantChannelId === channelId;
  const assistantChannel = followsDefault ? defaultChannel : channels.find((c) => c.id === assistantChannelId);
  const translateFollows = !translateChannelId || translateChannelId === channelId;
  const translateChannel = translateFollows ? defaultChannel : channels.find((c) => c.id === translateChannelId);

  useEffect(() => {
    if (!settings.data) return;
    const {
      enabled,
      channels,
      channelId,
      model,
      effort,
      assistantChannelId,
      assistantModel,
      assistantEffort,
      translateChannelId,
      translateModel,
      translateLanguage,
    } = settings.data;
    setChannels(channels);
    form.setFieldsValue({
      enabled,
      channelId: channelId || undefined,
      model,
      effort,
      assistantChannelId: assistantChannelId ?? '',
      assistantModel: assistantModel ?? '',
      assistantEffort: assistantEffort ?? '',
      translateChannelId: translateChannelId ?? '',
      translateModel: translateModel ?? '',
      translateLanguage,
    });
  }, [settings.data, form]);

  // 下拉选项：渠道的模型列表；Anthropic 渠道还没同步过时给出常用的 Claude 模型
  const modelOptions = (ch?: ChannelDraft) => {
    const list = ch?.models.length ? ch.models : ch?.provider === 'anthropic' ? CLAUDE_MODELS : [];
    return list.map((m) => {
      const hint = ch?.provider === 'anthropic' ? t.aiSettings.claudeHints[m] : undefined;
      return { value: m, label: hint ? t.aiSettings.withHint(m, hint) : m };
    });
  };
  const channelOptions = channels.map((c) => ({ value: c.id, label: c.name }));

  const filterOption = (input: string, option?: { value: string }) => !!option?.value.toLowerCase().includes(input.trim().toLowerCase());

  const payload = (v: FormValues) => ({
    ...v,
    channels: channels.map(toChannelInput),
    channelId: v.channelId ?? '',
    assistantChannelId: v.assistantChannelId || null,
    assistantModel: v.assistantModel?.trim() || null,
    assistantEffort: v.assistantEffort || null,
    translateChannelId: v.translateChannelId || null,
    translateModel: v.translateModel?.trim() || null,
  });

  const save = async () => {
    // validateFields 只返回挂载的字段，OpenAI 渠道下推理强度没有显示，要从 store 里取
    const values = { ...(form.getFieldsValue(true) as FormValues), ...(await form.validateFields()) };
    setSaving(true);
    try {
      await api('/api/admin/ai', { method: 'PUT', body: payload(values) });
      message.success(t.common.saved);
      await qc.invalidateQueries({ queryKey: ['ai-settings'] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (which: Which) => {
    const v = form.getFieldsValue(true) as FormValues;
    const ch = which === 'assistant' ? assistantChannel : which === 'translate' ? translateChannel : defaultChannel;
    if (!ch) return message.warning(t.aiSettings.pickChannelFirst);
    const model =
      which === 'assistant'
        ? v.assistantModel?.trim() || (followsDefault ? v.model : '')
        : which === 'translate'
          ? v.translateModel?.trim() || (translateFollows ? v.model : '')
          : v.model;
    if (!model) return message.warning(t.aiSettings.pickModelFirst);
    const effort = which === 'assistant' ? v.assistantEffort || null : which === 'translate' ? 'low' : v.effort;
    setTesting(which);
    setTest(null);
    try {
      const res = await api<{ ok: boolean; error?: string; ms?: number; insight?: Insight }>('/api/admin/ai/test', {
        method: 'POST',
        body: { channel: toChannelInput(ch), model, effort },
      });
      setTest({ ...res, model });
    } catch (e) {
      setTest({ ok: false, model, error: (e as Error).message });
    } finally {
      setTesting(null);
    }
  };

  // 默认渠道换了以后，原来的模型不在新渠道的列表里就换成列表里的第一个
  const pickDefaultChannel = (id: string, list = channels) => {
    const ch = list.find((c) => c.id === id);
    const model = form.getFieldValue('model') as string | undefined;
    if (ch?.models.length && !ch.models.includes(model ?? '')) form.setFieldValue('model', ch.models[0]);
    else if (ch?.provider === 'anthropic' && !ch.models.length && !model?.startsWith('claude')) form.setFieldValue('model', CLAUDE_MODELS[0]!);
  };

  const saveChannel = (ch: ChannelDraft) => {
    const exists = channels.some((c) => c.id === ch.id);
    const next = exists ? channels.map((c) => (c.id === ch.id ? ch : c)) : [...channels, ch];
    setChannels(next);
    setEditing(null);
    if (!channelId) {
      form.setFieldValue('channelId', ch.id);
      pickDefaultChannel(ch.id, next);
    }
    message.info(t.aiSettings.channelUpdated);
  };

  const removeChannel = (id: string) => {
    setChannels(channels.filter((c) => c.id !== id));
    if (assistantChannelId === id) form.setFieldsValue({ assistantChannelId: '', assistantModel: '' });
    if (translateChannelId === id) form.setFieldsValue({ translateChannelId: '', translateModel: '' });
  };

  if (oldTab === 'requests' || oldTab === 'stats') return <Navigate to={`/ai/${oldTab}`} replace />;
  if (settings.isPending) return <Spin style={{ margin: 48 }} />;
  const s = settings.data!;

  const keyStatus = (ch: ChannelDraft) => {
    if (ch.apiKey === '') return <Typography.Text type="warning">{t.aiSettings.willClear}</Typography.Text>;
    if (ch.apiKey) return <Typography.Text type="warning">{t.aiSettings.modified}</Typography.Text>;
    if (ch.hasApiKey)
      return (
        <Typography.Text code style={{ whiteSpace: 'nowrap' }}>
          {ch.apiKeyHint}
        </Typography.Text>
      );
    return <Typography.Text type="secondary">{t.aiSettings.notSet}</Typography.Text>;
  };

  return (
    <Form
      form={form}
      component={false}
      {...horizontalForm()}
      requiredMark={false}
      initialValues={{
        effort: 'low',
        enabled: false,
        assistantChannelId: '',
        assistantEffort: '',
        translateChannelId: '',
        translateLanguage: t.aiSettings.defaultLanguage,
      }}
    >
      <div style={{ padding: 24, height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
        <Flex align="center" justify="space-between" gap={16} wrap>
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {t.aiSettings.title}
            </Typography.Title>
            <Typography.Text type="secondary">{t.aiSettings.desc}</Typography.Text>
          </div>
          <Flex align="center" gap={12}>
            <Flex align="center" gap={8}>
              <Form.Item name="enabled" valuePropName="checked" noStyle>
                <Switch />
              </Form.Item>
              <Typography.Text>{t.aiSettings.enableAi}</Typography.Text>
            </Flex>
            <Button type="primary" loading={saving} onClick={save}>
              {t.aiSettings.saveSettings}
            </Button>
          </Flex>
        </Flex>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 16 }}>
          <Flex vertical gap={16}>
            <Card
              size="small"
              title={
                <Space>
                  <ApiOutlined />
                  {t.aiSettings.channels}
                </Space>
              }
              extra={
                <Button
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={() =>
                    setEditing({
                      id: newId(),
                      name: '',
                      provider: 'anthropic',
                      baseUrl: null,
                      models: [],
                      modelsSyncedAt: null,
                      prices: {},
                      priceRate: 1,
                      concurrency: null,
                      hasApiKey: false,
                      apiKeyHint: null,
                    })
                  }
                >
                  {t.aiSettings.addChannel}
                </Button>
              }
            >
              <Table<ChannelDraft>
                size="small"
                bordered
                rowKey="id"
                pagination={false}
                dataSource={channels}
                scroll={{ x: 990 }}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t.aiSettings.noChannels} /> }}
                columns={[
                  {
                    title: t.aiSettings.name,
                    key: 'name',
                    render: (_, ch) => (
                      <Space size={4} wrap>
                        <Typography.Text strong>{ch.name}</Typography.Text>
                        {ch.id === channelId && <Tag color="blue">{t.aiSettings.defaultTag}</Tag>}
                        {!followsDefault && ch.id === assistantChannelId && <Tag color="purple">{t.aiSettings.assistantTag}</Tag>}
                      </Space>
                    ),
                  },
                  { title: t.aiSettings.provider, key: 'provider', width: 130, render: (_, ch) => providerLabel(ch.provider) },
                  {
                    title: t.aiSettings.baseUrl,
                    key: 'baseUrl',
                    ellipsis: true,
                    render: (_, ch) =>
                      ch.baseUrl ?? (
                        <Typography.Text type="secondary">{ch.provider === 'anthropic' ? t.aiSettings.official : t.aiSettings.notFilled}</Typography.Text>
                      ),
                  },
                  {
                    title: t.aiSettings.model,
                    key: 'models',
                    width: 110,
                    render: (_, ch) => {
                      if (!ch.models.length) return <Typography.Text type="secondary">-</Typography.Text>;
                      const priced = ch.models.filter((m) => ch.prices[m]).length;
                      return (
                        <Tooltip title={t.aiSettings.pricedCount(priced)}>
                          {ch.models.length}
                          <Typography.Text type="secondary">{t.aiSettings.priced(priced)}</Typography.Text>
                        </Tooltip>
                      );
                    },
                  },
                  {
                    title: t.aiSettings.status,
                    key: 'status',
                    width: 170,
                    render: (_, ch) => <ChannelState s={channelStatus.data?.[ch.id]} />,
                  },
                  {
                    title: t.aiSettings.concurrency,
                    key: 'concurrency',
                    width: 100,
                    align: 'right',
                    render: (_, ch) => ch.concurrency ?? <Typography.Text type="secondary">{t.aiSettings.unlimited}</Typography.Text>,
                  },
                  { title: 'API Key', key: 'key', width: 180, render: (_, ch) => keyStatus(ch) },
                  {
                    title: t.aiSettings.actions,
                    key: 'actions',
                    width: 100,
                    fixed: 'end',
                    render: (_, ch) => (
                      <Space size={0}>
                        <Button type="text" size="small" icon={<EditOutlined />} aria-label={t.common.edit} onClick={() => setEditing(ch)} />
                        <Tooltip title={ch.id === channelId ? t.aiSettings.cantDeleteDefault : undefined}>
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            aria-label={t.common.delete}
                            disabled={ch.id === channelId}
                            onClick={() => removeChannel(ch.id)}
                          />
                        </Tooltip>
                      </Space>
                    ),
                  },
                ]}
              />
            </Card>

            <Card
              size="small"
              title={
                <Space>
                  <RobotOutlined />
                  {t.aiSettings.model}
                </Space>
              }
            >
              <Row gutter={[16, 16]}>
                <Col xs={24} lg={12} xxl={8}>
                  <Card
                    type="inner"
                    size="small"
                    title={t.aiSettings.defaultModel}
                    extra={
                      <Button size="small" type="link" icon={<ExperimentOutlined />} loading={testing === 'default'} onClick={() => runTest('default')}>
                        {t.aiSettings.test}
                      </Button>
                    }
                    style={{ height: '100%' }}
                  >
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                      {t.aiSettings.defaultDesc}
                    </Typography.Paragraph>
                    <Form.Item name="channelId" label={t.aiSettings.channel} rules={[{ required: channels.length > 0, message: t.aiSettings.channelRequired }]}>
                      <Select options={channelOptions} placeholder={t.aiSettings.addChannelFirst} onChange={(id: string) => pickDefaultChannel(id)} />
                    </Form.Item>
                    <Form.Item name="model" label={t.aiSettings.model} rules={[{ required: true, message: t.aiSettings.modelRequired }]}>
                      <AutoComplete options={modelOptions(defaultChannel)} showSearch={{ filterOption }} placeholder={t.aiSettings.pickOrType} />
                    </Form.Item>
                    {defaultChannel?.provider !== 'openai' && (
                      <Form.Item name="effort" label={t.aiSettings.effort} extra={t.aiSettings.effortExtra} style={{ marginBottom: 0 }}>
                        <Segmented options={effortOptions('anthropic').slice(0, 3)} />
                      </Form.Item>
                    )}
                  </Card>
                </Col>
                <Col xs={24} lg={12} xxl={8}>
                  <Card
                    type="inner"
                    size="small"
                    title={t.aiSettings.assistant}
                    extra={
                      <Button size="small" type="link" icon={<ExperimentOutlined />} loading={testing === 'assistant'} onClick={() => runTest('assistant')}>
                        {t.aiSettings.test}
                      </Button>
                    }
                    style={{ height: '100%' }}
                  >
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                      {t.aiSettings.assistantDesc}
                    </Typography.Paragraph>
                    <Form.Item name="assistantChannelId" label={t.aiSettings.channel}>
                      <Select
                        options={[{ value: '', label: t.aiSettings.followChannel(defaultChannel?.name ?? null) }, ...channelOptions]}
                        onChange={() => form.setFieldValue('assistantModel', '')}
                      />
                    </Form.Item>
                    <Form.Item
                      name="assistantModel"
                      label={t.aiSettings.model}
                      rules={[{ required: !followsDefault, whitespace: true, message: t.aiSettings.modelForChannel }]}
                    >
                      <AutoComplete
                        allowClear
                        options={modelOptions(assistantChannel)}
                        showSearch={{ filterOption }}
                        placeholder={followsDefault ? t.aiSettings.followModel(defaultModel || null) : t.aiSettings.pickOrType}
                      />
                    </Form.Item>
                    <Form.Item
                      name="assistantEffort"
                      label={t.aiSettings.thinking}
                      extra={assistantChannel?.provider === 'openai' ? undefined : t.aiSettings.thinkingExtra}
                      style={{ marginBottom: 0 }}
                    >
                      <Segmented options={[{ value: '', label: t.aiSettings.default }, ...effortOptions(assistantChannel?.provider ?? 'anthropic')]} />
                    </Form.Item>
                  </Card>
                </Col>
                <Col xs={24} lg={12} xxl={8}>
                  <Card
                    type="inner"
                    size="small"
                    title={t.aiSettings.translate}
                    extra={
                      <Button size="small" type="link" icon={<ExperimentOutlined />} loading={testing === 'translate'} onClick={() => runTest('translate')}>
                        {t.aiSettings.test}
                      </Button>
                    }
                    style={{ height: '100%' }}
                  >
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                      {t.aiSettings.translateDesc}
                    </Typography.Paragraph>
                    <Form.Item name="translateChannelId" label={t.aiSettings.channel}>
                      <Select
                        options={[{ value: '', label: t.aiSettings.followChannel(defaultChannel?.name ?? null) }, ...channelOptions]}
                        onChange={() => form.setFieldValue('translateModel', '')}
                      />
                    </Form.Item>
                    <Form.Item
                      name="translateModel"
                      label={t.aiSettings.model}
                      rules={[{ required: !translateFollows, whitespace: true, message: t.aiSettings.modelForChannel }]}
                    >
                      <AutoComplete
                        allowClear
                        options={modelOptions(translateChannel)}
                        showSearch={{ filterOption }}
                        placeholder={translateFollows ? t.aiSettings.followModel(defaultModel || null) : t.aiSettings.pickOrType}
                      />
                    </Form.Item>
                    <Form.Item
                      name="translateLanguage"
                      label={t.aiSettings.translateTo}
                      rules={[{ required: true, whitespace: true, message: t.aiSettings.languageRequired }]}
                      style={{ marginBottom: 0 }}
                    >
                      <AutoComplete options={TRANSLATE_LANGUAGES.map((l) => ({ value: l }))} placeholder={t.aiSettings.pickLanguage} />
                    </Form.Item>
                  </Card>
                </Col>
              </Row>

              {test && (
                <div style={{ marginTop: 16 }}>
                  {test.ok ? (
                    <>
                      <Alert
                        type="success"
                        showIcon
                        closable={{ onClose: () => setTest(null) }}
                        title={
                          <>
                            <Tag style={{ marginInlineEnd: 6 }}>{test.model}</Tag>
                            {t.aiSettings.testOk(((test.ms ?? 0) / 1000).toFixed(1))}
                          </>
                        }
                        style={{ marginBottom: 12 }}
                      />
                      {test.insight && <InsightCard insight={test.insight} />}
                    </>
                  ) : (
                    <Alert
                      type="error"
                      showIcon
                      closable={{ onClose: () => setTest(null) }}
                      title={t.aiSettings.testFailed(test.model)}
                      description={test.error}
                    />
                  )}
                </div>
              )}
            </Card>
          </Flex>
        </div>
      </div>

      {editing && <ChannelModal key={editing.id} channel={editing} onCancel={() => setEditing(null)} onOk={saveChannel} />}
    </Form>
  );
}
