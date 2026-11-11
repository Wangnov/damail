import {
  BulbOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  MailOutlined,
  PlusOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Bubble, Conversations, Sender, Suggestion, type BubbleItemType, type ConversationsProps } from '@ant-design/x';
import XMarkdown from '@ant-design/x-markdown';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Flex, Input, Popover, Select, Spin, Tooltip, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { api, type AiEffort, type AiProvider, type Thread } from '../api';
import { t } from '../i18n';
import type { AssistantProps } from './Assistant';
import {
  AnswerActions,
  AnswerError,
  AssistantWelcome,
  MessageSources,
  ThinkingBlock,
  STOPPED,
  suggestions,
  ToolChain,
  citedIds,
  fetchMessage,
  messageQueryKey,
} from './AssistantParts';
import { MARKDOWN_COMPONENTS, withCitations } from './assistant/markdown';
import type { ConversationSummary, MsgContext } from './assistant/types';
import { LIST_KEY, readLocal, setConversationTitle, useAssistantChat, writeLocal } from './assistant/useAssistantChat';
import { EmptyBlock } from './EmptyBlock';

const MODEL_KEY = 'damail.assistant.model';
const EFFORT_KEY = 'damail.assistant.effort';

type ModelOptions = {
  channels: Array<{ id: string; name: string; provider: AiProvider; models: string[] }>;
  default: { channelId: string | null; model: string; provider: AiProvider; effort: AiEffort | null };
};

// OpenAI 兼容接口的 reasoning_effort 一般只认 low / medium / high
const EFFORTS: Record<AiProvider, AiEffort[]> = { anthropic: ['low', 'medium', 'high', 'xhigh', 'max'], openai: ['low', 'medium', 'high'] };
// 下拉的值是「渠道 id + 分隔符 + 模型名」，空串表示用模型配置里的默认
const SEP = '\u0000';
// 展开时对话内容的最大宽度，太宽一行读起来费劲
const READ_WIDTH = 820;

/** 按最近更新时间分组 */
function groupOf(updatedAt: string) {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(new Date(updatedAt))) / 86_400_000);
  const g = t.assistant.groups;
  if (diff <= 0) return g.today;
  if (diff === 1) return g.yesterday;
  if (diff < 7) return g.week;
  return g.older;
}

const threadUrl = (threadId: string) => `/mail?view=all&thread=${encodeURIComponent(threadId)}`;

export default function AssistantPanel({ open, expanded, username, onClose, onExpand }: AssistantProps) {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { activeId, messages: msgs, busy, loading: loadingConv, send: sendMessage, stop, switchTo } = useAssistantChat();
  const [input, setInput] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);

  // 对话框里临时选的模型和思考强度，记在本地，下次打开沿用
  const [pick, setPick] = useState(() => readLocal(MODEL_KEY) ?? '');
  const [effort, setEffort] = useState(() => readLocal(EFFORT_KEY) ?? '');
  const modelOptions = useQuery({ queryKey: ['assistant-models'], queryFn: () => api<ModelOptions>('/api/admin/assistant/models'), enabled: open });
  const opts = modelOptions.data;
  const [pickChannel, pickModel] = pick.split(SEP);
  const picked = pick ? opts?.channels.find((c) => c.id === pickChannel && c.models.includes(pickModel ?? '')) : undefined;
  // 选的模型被删掉了就当作默认
  const modelValue = picked ? pick : '';
  const provider = picked?.provider ?? opts?.default.provider ?? 'anthropic';
  const effortValue = EFFORTS[provider].includes(effort as AiEffort) ? effort : '';
  const choose = (key: string, value: string, set: (v: string) => void) => {
    set(value);
    writeLocal(key, value || null);
  };
  const list = useQuery({ queryKey: LIST_KEY, queryFn: () => api<{ items: ConversationSummary[] }>('/api/admin/assistant/conversations'), enabled: open });

  // 当前邮件：邮件页打开了某个会话时，提问默认附带它；可以去掉，换一封邮件后重新附带
  const location = useLocation();
  const [params] = useSearchParams();
  const threadId = location.pathname === '/mail' ? params.get('thread') : null;
  const thread = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => api<Thread>(`/api/v1/threads/${encodeURIComponent(threadId!)}`),
    enabled: open && !!threadId,
  });
  const [detached, setDetached] = useState<string | null>(null);
  const threadSubject = thread.data ? thread.data.subject || t.assistant.noSubject : null;
  const context: MsgContext | undefined = threadId && threadSubject && detached !== threadId ? { threadId, subject: threadSubject } : undefined;

  const send = (text: string) => {
    const sent = sendMessage(text, {
      ...(picked ? { channelId: picked.id, model: pickModel } : {}),
      ...(effortValue ? { effort: effortValue as AiEffort } : {}),
      ...(context ? { context } : {}),
    });
    if (sent) setInput('');
  };

  const newChat = () => {
    switchTo(null);
    setHistoryOpen(false);
  };

  const openMessage = async (id: number) => {
    try {
      // 和引用列表共用缓存，展开过的邮件点开不用再请求
      const m = await qc.fetchQuery({ queryKey: messageQueryKey(id), queryFn: () => fetchMessage(id), staleTime: Infinity });
      navigate(threadUrl(m.threadId));
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const remove = (c: ConversationSummary) =>
    modal.confirm({
      title: t.assistant.deleteTitle,
      content: t.assistant.deleteContent(c.title),
      okText: t.common.delete,
      okButtonProps: { danger: true },
      onOk: async () => {
        await api(`/api/admin/assistant/conversations/${c.id}`, { method: 'DELETE' });
        if (c.id === activeId) switchTo(null);
        await qc.invalidateQueries({ queryKey: LIST_KEY });
      },
    });

  const rename = (c: ConversationSummary) => {
    let value = c.title;
    modal.confirm({
      title: t.assistant.renameTitle,
      icon: null,
      content: <Input defaultValue={c.title} maxLength={60} autoFocus onChange={(e) => (value = e.target.value)} aria-label={t.assistant.conversationTitle} />,
      okText: t.common.save,
      onOk: async () => {
        if (!value.trim() || value.trim() === c.title) return;
        await api(`/api/admin/assistant/conversations/${c.id}`, { method: 'PATCH', body: { title: value.trim() } });
        setConversationTitle(qc, c.id, value.trim());
      },
    });
  };

  // components / componentsProps 要保持引用稳定，否则流式输出时链接会反复重新挂载
  const openRef = useRef(openMessage);
  openRef.current = openMessage;
  // MARKDOWN_COMPONENTS 是模块级常量，引用本身就稳定
  const markdownComponents = MARKDOWN_COMPONENTS;
  const markdownProps = useMemo(() => ({ a: { onOpenMessage: (id: number) => openRef.current(id) } }), []);

  const conversations = list.data?.items ?? [];
  const activeTitle = conversations.find((c) => c.id === activeId)?.title;

  /** 会话列表：浮动卡片里在标题下拉中，展开后在左侧（样式和菜单面板一致） */
  const conversationList = (className: string) => {
    const props: ConversationsProps = {
      className,
      items: conversations.map((c) => ({ key: String(c.id), label: c.title, group: groupOf(c.updatedAt), title: c.title })),
      activeKey: activeId ? String(activeId) : undefined,
      onActiveChange: (key) => {
        switchTo(Number(key));
        setHistoryOpen(false);
      },
      groupable: true,
      menu: (item) => ({
        items: [
          { key: 'rename', label: t.assistant.rename, icon: <EditOutlined /> },
          { key: 'delete', label: t.common.delete, icon: <DeleteOutlined />, danger: true },
        ],
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          const c = conversations.find((x) => String(x.id) === item.key);
          if (!c) return;
          setHistoryOpen(false);
          if (key === 'delete') remove(c);
          else rename(c);
        },
      }),
    };
    if (list.isLoading)
      return (
        <Flex justify="center" style={{ padding: 24 }}>
          <Spin size="small" />
        </Flex>
      );
    if (!conversations.length) return <EmptyBlock description={t.assistant.noConversations} minHeight={120} style={{ height: 'auto' }} />;
    return <Conversations {...props} />;
  };

  // 重新生成 / 重试：把这条回答对应的用户问题再发一次（沿用当时附带的邮件）
  let question = '';
  const items: BubbleItemType[] = msgs.map(({ key, msg: m, streaming }) => {
    if (m.role === 'user') {
      question = m.content;
      const ctx = m.context;
      return {
        key,
        role: 'user',
        content: m.content,
        header: ctx && (
          <span
            className="assistant-context-ref"
            role="link"
            tabIndex={0}
            title={t.assistant.openRef(ctx.subject)}
            onClick={() => navigate(threadUrl(ctx.threadId))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate(threadUrl(ctx.threadId));
            }}
          >
            <MailOutlined />
            <span>{ctx.subject}</span>
          </span>
        ),
      };
    }
    const ask = question;
    const retry = ask && !busy ? () => send(ask) : undefined;
    const failed = !!m.error && m.error !== STOPPED;
    const cited = !streaming && m.content ? citedIds(m.content) : [];
    const steps = m.steps ?? [];
    // 正文或工具开始后，思考阶段就结束了
    const thinkingActive = streaming && !!m.thinking && !m.content && !steps.some((s) => s.status === 'running');
    const idle = streaming && !m.content && !m.thinking && !steps.length;
    return {
      key,
      role: 'ai',
      content: m.content,
      contentRender: (content: string) => (
        <Flex vertical gap={10} className="assistant-answer">
          {m.thinking && <ThinkingBlock text={m.thinking} ms={m.thinkingMs} active={thinkingActive} />}
          {steps.length > 0 && <ToolChain steps={steps} active={streaming} onOpenDrafts={() => navigate('/outbox')} />}
          {idle && (
            <Flex align="center" gap={8} className="assistant-pending">
              <span className="assistant-dots">
                <i />
                <i />
                <i />
              </span>
              <Typography.Text type="secondary">{t.assistant.thinkingNow}</Typography.Text>
            </Flex>
          )}
          {content && (
            <XMarkdown
              className="md assistant-md"
              content={withCitations(content, streaming)}
              streaming={streaming ? { hasNextChunk: true, incompleteMarkdown: 'complete', tail: true } : false}
              components={markdownComponents}
              componentsProps={markdownProps}
              escapeRawHtml
            />
          )}
          {cited.length > 0 && <MessageSources ids={cited} onOpen={(id) => openRef.current(id)} />}
          {failed && <AnswerError error={m.error!} onRetry={retry} />}
          {m.error === STOPPED && (
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {t.assistant.stopped}
            </Typography.Text>
          )}
        </Flex>
      ),
      footer:
        !streaming && (m.content || m.model) ? (
          <AnswerActions content={m.content} onRegenerate={failed ? undefined : retry} model={m.model} channelName={m.channelName} usage={m.usage} />
        ) : undefined,
    };
  });

  const canStartNew = !!activeId || msgs.length > 0;

  // 当前邮件：附带时显示在输入框上方，可以去掉；去掉后留一个「附带当前邮件」的入口
  const contextBar = threadId && threadSubject && (
    <div className="assistant-context-bar">
      {context ? (
        <span className="assistant-context on" title={context.subject}>
          <MailOutlined />
          <span className="assistant-context-text">
            {t.assistant.currentEmail}
            <b>{context.subject}</b>
          </span>
          <button type="button" aria-label={t.assistant.detach} title={t.assistant.detach} onClick={() => setDetached(threadId)}>
            <CloseOutlined />
          </button>
        </span>
      ) : (
        <button type="button" className="assistant-context" onClick={() => setDetached(null)} title={threadSubject}>
          <PlusOutlined />
          <span className="assistant-context-text">{t.assistant.attach}</span>
        </button>
      )}
    </div>
  );

  const iconButton = (title: string, icon: React.ReactNode, onClick: () => void, disabled?: boolean) => (
    <Tooltip title={title}>
      <Button type="text" size="small" icon={icon} onClick={onClick} disabled={disabled} aria-label={title} className="assistant-head-btn" />
    </Tooltip>
  );

  return (
    <aside className={`assistant-dock ${expanded ? 'expanded' : 'floating'}`} style={{ display: open ? undefined : 'none' }} aria-label={t.assistant.title}>
      {expanded && (
        // 展开：左侧会话列表放在浅灰底上，和菜单面板一个样式
        <nav className="assistant-nav" aria-label={t.assistant.conversations}>
          <Flex align="center" style={{ height: 56, padding: '0 10px', flex: 'none' }}>
            <span className="app-nav-title">{t.assistant.title}</span>
          </Flex>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            className="compose-button"
            onClick={newChat}
            disabled={!canStartNew}
            style={{ flex: 'none', marginBottom: 8 }}
          >
            {t.assistant.newChat}
          </Button>
          <div className="assistant-nav-list">{conversationList('assistant-convs nav-style')}</div>
        </nav>
      )}
      <section className="assistant-main">
        <header className="assistant-head">
          {expanded ? (
            <Typography.Text strong ellipsis className="assistant-head-title">
              {activeTitle ?? t.assistant.newChat}
            </Typography.Text>
          ) : (
            // 浮动卡片：点标题切换历史会话
            <Popover
              open={historyOpen}
              onOpenChange={setHistoryOpen}
              trigger="click"
              placement="bottomLeft"
              arrow={false}
              content={<div className="assistant-history">{conversationList('assistant-convs')}</div>}
            >
              <button type="button" className="assistant-title" aria-label={t.assistant.switchConversation} aria-expanded={historyOpen}>
                <span className="assistant-logo">
                  <RobotOutlined />
                </span>
                <span className="assistant-title-text">{activeTitle ?? t.assistant.newChat}</span>
                <DownOutlined className="assistant-title-caret" />
              </button>
            </Popover>
          )}
          <Flex gap={2} style={{ flex: 'none' }}>
            {!expanded && iconButton(t.assistant.newChat, <PlusOutlined />, newChat, !canStartNew)}
            {expanded
              ? iconButton(t.assistant.collapse, <FullscreenExitOutlined />, () => onExpand(false))
              : iconButton(t.assistant.expand, <FullscreenOutlined />, () => onExpand(true))}
            {iconButton(t.assistant.close, <CloseOutlined />, onClose)}
          </Flex>
        </header>
        {loadingConv ? (
          <Flex flex={1} align="center" justify="center">
            <Spin />
          </Flex>
        ) : msgs.length === 0 ? (
          <Flex vertical justify="center" className="assistant-empty">
            <AssistantWelcome username={username} withEmail={!!context} onPick={send} />
          </Flex>
        ) : (
          <Bubble.List
            items={items}
            autoScroll
            style={{ flex: 1, minHeight: 0 }}
            styles={{ scroll: { padding: expanded ? `20px max(20px, calc((100% - ${READ_WIDTH}px) / 2))` : '12px 14px', boxSizing: 'border-box' } }}
            role={{
              user: {
                placement: 'end',
                shape: 'round',
                className: 'assistant-user',
                contentRender: (content: string) => <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>,
              },
              ai: { placement: 'start', variant: 'borderless', className: 'assistant-ai' },
            }}
          />
        )}
        <div className="assistant-composer" style={expanded ? { width: '100%', maxWidth: READ_WIDTH + 40, marginInline: 'auto' } : undefined}>
          {/* 输入 / 弹出快捷指令，选中后把对应问题填进输入框 */}
          <Suggestion
            items={suggestions().map((s) => ({ value: s.key, icon: s.icon, label: s.title, extra: s.prompt }))}
            onSelect={(key) => {
              const s = suggestions().find((x) => x.key === key);
              setInput(s?.prompt ?? '');
            }}
            rootClassName="assistant-suggestion"
          >
            {({ onTrigger, onKeyDown }) => (
              <Sender
                className="assistant-sender"
                value={input}
                onChange={(v) => {
                  setInput(v);
                  onTrigger(v === '/' ? {} : false);
                }}
                onKeyDown={onKeyDown}
                onSubmit={(v) => send(v)}
                loading={busy}
                onCancel={stop}
                disabled={loadingConv}
                autoSize={{ minRows: 2, maxRows: 8 }}
                placeholder={context ? t.assistant.placeholderWithEmail : t.assistant.placeholder}
                header={contextBar || undefined}
                // 发送按钮挪到底栏右侧，和模型、思考强度排在同一行
                suffix={false}
                footer={(actionNode) => (
                  <Flex align="center" justify="space-between" gap={8}>
                    {/* 窄的时候不换行，模型名过长时省略，思考强度保持完整 */}
                    <Flex align="center" gap={6} style={{ minWidth: 0 }}>
                      {/* 按钮上只显示模型名（完整说明悬停可见、下拉里有），改过默认值时高亮成主色 */}
                      <Select
                        variant="borderless"
                        className={`assistant-chip${modelValue ? ' assistant-chip-on' : ''}`}
                        prefix={<ThunderboltOutlined />}
                        value={modelValue}
                        onChange={(v: string) => choose(MODEL_KEY, v, setPick)}
                        labelRender={({ value }) => (value ? String(value).split(SEP)[1] : (opts?.default.model ?? t.assistant.defaultModelPlain))}
                        popupMatchSelectWidth={false}
                        style={{ flex: '0 1 auto', minWidth: 0, maxWidth: 200 }}
                        aria-label={t.assistant.model}
                        options={[
                          { value: '', label: opts ? t.assistant.defaultModel(opts.default.model) : t.assistant.defaultModelPlain },
                          ...(opts?.channels
                            .filter((c) => c.models.length)
                            .map((c) => ({ label: c.name, title: c.name, options: c.models.map((m) => ({ value: `${c.id}${SEP}${m}`, label: m })) })) ?? []),
                        ]}
                      />
                      <Select
                        variant="borderless"
                        className={`assistant-chip${effortValue ? ' assistant-chip-on' : ''}`}
                        prefix={<BulbOutlined />}
                        style={{ flex: 'none' }}
                        value={effortValue}
                        onChange={(v: string) => choose(EFFORT_KEY, v, setEffort)}
                        labelRender={({ value }) => t.assistant.effortChip(value ? t.assistant.effort[value as AiEffort] : null)}
                        popupMatchSelectWidth={false}
                        aria-label={t.assistant.effortLabel}
                        options={[
                          {
                            value: '',
                            label: t.assistant.effortDefault(opts?.default.effort ? t.assistant.effort[opts.default.effort] : null),
                          },
                          ...EFFORTS[provider].map((v) => ({ value: v, label: t.assistant.effortValue(t.assistant.effort[v]) })),
                        ]}
                      />
                    </Flex>
                    {actionNode}
                  </Flex>
                )}
              />
            )}
          </Suggestion>
        </div>
      </section>
    </aside>
  );
}
