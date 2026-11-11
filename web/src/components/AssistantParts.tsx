import {
  BarChartOutlined,
  BulbOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CreditCardOutlined,
  EditOutlined,
  FileDoneOutlined,
  LoadingOutlined,
  MailOutlined,
  MessageOutlined,
  MinusCircleFilled,
  ReadOutlined,
  RedoOutlined,
  RightOutlined,
  RobotOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { Actions, Sources, Think } from '@ant-design/x';
import XMarkdown from '@ant-design/x-markdown';
import { useQueries } from '@tanstack/react-query';
import { Alert, Button, Flex, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useState, type ReactNode } from 'react';
import { api, type MessageDetail } from '../api';
import { greeting } from '../lib/format';
import { intlLocale, t } from '../i18n';
import type { Step, Usage } from './assistant/types';

// / 快捷指令；前四个也是欢迎页的卡片
const SUGGESTION_ICONS = {
  bills: <CreditCardOutlined />,
  reply: <MessageOutlined />,
  digest: <ReadOutlined />,
  draft: <EditOutlined />,
  stats: <BarChartOutlined />,
};
/** 按当前界面语言生成（问题也用这种语言问，AI 跟着用这种语言回答） */
export const suggestions = (): Array<{ key: string; icon: ReactNode; title: string; desc: string; prompt: string }> =>
  (Object.keys(SUGGESTION_ICONS) as Array<keyof typeof SUGGESTION_ICONS>).map((key) => ({ key, icon: SUGGESTION_ICONS[key], ...t.assistant.suggestions[key] }));

const seconds = (ms: number) => (ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000)));

/** 1234 → 1.2k，界面上一眼能看清量级，精确值放在提示里 */
export function compact(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatCost(v: number) {
  if (v === 0) return '$0';
  if (v < 0.0001) return '<$0.0001';
  if (v < 0.01) return `$${Number(v.toPrecision(2))}`;
  return `$${v.toFixed(v < 100 ? 4 : 2).replace(/\.?0+$/, '')}`;
}

/** 思考过程：进行中展开并计时，结束后收起成「已思考 N 秒」；工具调用后再次思考会重新展开 */
export function ThinkingBlock({ text, ms, active }: { text: string; ms?: number; active: boolean }) {
  const [expanded, setExpanded] = useState(active);
  // 当前这一段思考的开始时间；之前各段的用时已经累加在 ms 里
  const [segmentStart, setSegmentStart] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setExpanded(active);
    if (!active) return;
    const start = Date.now();
    setSegmentStart(start);
    setNow(start);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const elapsed = active ? (ms ?? 0) + Math.max(0, now - segmentStart) : ms;
  return (
    <Think
      className="assistant-think"
      icon={<BulbOutlined />}
      title={active ? t.assistant.thinking(Math.floor((elapsed ?? 0) / 1000)) : elapsed ? t.assistant.thought(seconds(elapsed)) : t.assistant.thinkingProcess}
      loading={active}
      blink={active}
      expanded={expanded}
      onExpand={setExpanded}
    >
      <XMarkdown className="md assistant-md assistant-think-md" content={text} escapeRawHtml />
    </Think>
  );
}

// 「已停止」是前后端约定的标记值（存进历史里），显示时再按语言翻译
export const STOPPED = '已停止';
const isStopped = (s: Step) => s.status === 'error' && s.summary === STOPPED;

function StepIcon({ step }: { step: Step }) {
  if (step.status === 'running') return <LoadingOutlined className="assistant-step-icon running" />;
  if (step.status === 'ok') return <CheckCircleFilled className="assistant-step-icon ok" />;
  if (isStopped(step)) return <MinusCircleFilled className="assistant-step-icon stopped" />;
  return <CloseCircleFilled className="assistant-step-icon error" />;
}

function DraftLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="assistant-draft-link" onClick={onClick}>
      <FileDoneOutlined />
      {t.assistant.openDrafts}
    </button>
  );
}

/** 工具调用：一行摘要，进行中显示当前步骤；点开是紧凑的步骤列表，每步一行（名称 + 结果） */
export function ToolChain({ steps, active, onOpenDrafts }: { steps: Step[]; active: boolean; onOpenDrafts: () => void }) {
  const running = steps.some((s) => s.status === 'running');
  const failed = steps.filter((s) => s.status === 'error' && !isStopped(s)).length;
  const drafts = steps.filter((s) => s.draftId).length;
  const [expanded, setExpanded] = useState(false);
  const current = steps.findLast((s) => s.status === 'running');
  const title = running ? `${current?.label ?? t.assistant.processing}…` : t.assistant.stepsDone(steps.length, failed);

  return (
    <div className="assistant-chain">
      <Flex align="center" gap={8} wrap>
        <button type="button" className="assistant-chain-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {running ? <LoadingOutlined /> : <ToolOutlined />}
          <span className={running ? 'assistant-chain-title blink' : 'assistant-chain-title'}>{title}</span>
          <RightOutlined className="assistant-chain-caret" />
        </button>
        {/* 收起时草稿入口也不能藏起来 */}
        {!expanded && !active && drafts > 0 && (
          <span className="assistant-chain-drafts">
            {t.assistant.draftsCreated(drafts)}
            <DraftLink onClick={onOpenDrafts} />
          </span>
        )}
      </Flex>
      {expanded && (
        <ol className="assistant-steps">
          {steps.map((s) => (
            <li key={s.id} className={`assistant-step${s.status === 'error' && !isStopped(s) ? ' error' : ''}`}>
              <StepIcon step={s} />
              <span className="assistant-step-label" title={s.label}>
                {s.label}
              </span>
              {s.summary && (
                <span className="assistant-step-summary" title={s.summary}>
                  {isStopped(s) ? t.assistant.stopped : s.summary}
                </span>
              )}
              {s.draftId && <DraftLink onClick={onOpenDrafts} />}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** 输出速度：只按出字时间算；输出太少或太快时误差大，不显示 */
function tokensPerSecond(u: Usage) {
  if (!u.genMs || u.genMs < 300 || u.outputTokens < 20) return null;
  return Math.round(u.outputTokens / (u.genMs / 1000));
}

/** 回答下方的信息：模型 · tokens · 速度 · 费用 · 耗时，悬停看明细 */
export function UsageMeta({ model, channelName, usage }: { model?: string; channelName?: string | null; usage?: Usage }) {
  if (!model && !usage) return null;
  const speed = usage && tokensPerSecond(usage);
  const parts = [
    model,
    usage && `${compact(usage.inputTokens)} / ${compact(usage.outputTokens)} tokens`,
    speed && `${speed} tokens/s`,
    usage?.cost != null && formatCost(usage.cost),
    usage && `${seconds(usage.durationMs)}s`,
  ].filter(Boolean);
  const detail = usage ? (
    <div style={{ fontSize: 12, lineHeight: 1.8 }}>
      {model && <div>{t.assistant.usage.model(model)}</div>}
      {channelName && <div>{t.assistant.usage.channel(channelName)}</div>}
      <div>
        {t.assistant.usage.input(usage.inputTokens.toLocaleString(intlLocale()))}
        {usage.cacheReadTokens ? t.assistant.usage.cacheHit(usage.cacheReadTokens.toLocaleString(intlLocale())) : ''}
      </div>
      <div>{t.assistant.usage.output(usage.outputTokens.toLocaleString(intlLocale()))}</div>
      {speed && <div>{t.assistant.usage.speed(speed)}</div>}
      {usage.ttftMs != null && <div>{t.assistant.usage.ttft(seconds(usage.ttftMs))}</div>}
      <div>{t.assistant.usage.cost(usage.cost == null ? null : formatCost(usage.cost))}</div>
      <div>{t.assistant.usage.duration(seconds(usage.durationMs), usage.rounds)}</div>
    </div>
  ) : (
    channelName && t.assistant.usage.channel(channelName)
  );
  return (
    <Tooltip title={detail} placement="bottomLeft">
      <Typography.Text type="secondary" className="assistant-meta">
        {parts.join(' · ')}
      </Typography.Text>
    </Tooltip>
  );
}

/** 欢迎页：问候 + 四个常用场景，点一下直接提问 */
export function AssistantWelcome({ username, withEmail, onPick }: { username: string; withEmail: boolean; onPick: (prompt: string) => void }) {
  return (
    <div className="assistant-hello">
      <span className="assistant-welcome-icon">
        <RobotOutlined />
      </span>
      <div className="assistant-hello-title">{t.assistant.hello(greeting(), username)}</div>
      <div className="assistant-hello-desc">{t.assistant.helloDesc}</div>
      <div className="assistant-cards">
        {suggestions()
          .slice(0, 4)
          .map((s) => {
            // 附带了当前邮件时，「起草回复」直接针对这封
            const prompt = s.key === 'draft' && withEmail ? t.assistant.draftThis : s.prompt;
            return (
              <button key={s.key} type="button" className="assistant-card" title={prompt} onClick={() => onPick(prompt)}>
                <span className="assistant-card-icon">{s.icon}</span>
                <span className="assistant-card-title">{s.key === 'draft' && withEmail ? t.assistant.replyThis : s.title}</span>
                <span className="assistant-card-desc">{s.desc}</span>
              </button>
            );
          })}
      </div>
    </div>
  );
}

/** 回答出错：错误样式 + 重试 */
export function AnswerError({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <Alert
      type="error"
      showIcon
      className="assistant-error"
      title={error}
      action={
        onRetry && (
          <Button size="small" icon={<RedoOutlined />} onClick={onRetry}>
            {t.common.retry}
          </Button>
        )
      }
    />
  );
}

/** 回答下方的操作栏：左边复制、重新生成，右边用量信息 */
export function AnswerActions({
  content,
  onRegenerate,
  model,
  channelName,
  usage,
}: {
  content: string;
  onRegenerate?: () => void;
  model?: string;
  channelName?: string | null;
  usage?: Usage;
}) {
  const items = [
    ...(content ? [{ key: 'copy', label: t.common.copy, actionRender: () => <Actions.Copy text={content} /> }] : []),
    ...(onRegenerate ? [{ key: 'regenerate', label: t.assistant.regenerate, icon: <RedoOutlined />, onItemClick: onRegenerate }] : []),
  ];
  return (
    <Flex align="center" gap={8} className="assistant-footer">
      {items.length > 0 ? <Actions items={items} className="assistant-actions" /> : <span />}
      <UsageMeta model={model} channelName={channelName} usage={usage} />
    </Flex>
  );
}

/** 回答里引用的邮件 id（[#123]），按出现顺序去重 */
export function citedIds(text: string) {
  return [...new Set([...text.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1])))];
}

export const messageQueryKey = (id: number) => ['assistant-message', id];
export const fetchMessage = (id: number) => api<MessageDetail>(`/api/v1/messages/${id}?format=text`);

/** 引用的邮件：默认收起，展开时才去取标题，点击跳到对应会话 */
export function MessageSources({ ids, onOpen }: { ids: number[]; onOpen: (id: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const results = useQueries({
    queries: ids.map((id) => ({ queryKey: messageQueryKey(id), queryFn: () => fetchMessage(id), enabled: expanded, staleTime: Infinity, retry: false })),
  });
  return (
    <Sources
      className="assistant-sources"
      title={t.assistant.cited(ids.length)}
      expanded={expanded}
      onExpand={setExpanded}
      items={ids.map((id, i) => {
        const m = results[i]?.data;
        const from = m && (m.from.name || m.from.address);
        return {
          key: id,
          icon: <MailOutlined />,
          // Sources 的 onClick 也会挂到根节点上（点标题展开也会触发），所以点击放在每一项自己身上
          title: (
            <span
              className="assistant-source"
              role="link"
              tabIndex={0}
              onClick={() => onOpen(id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen(id);
              }}
            >
              <span className="assistant-source-subject">
                {m ? m.subject || t.assistant.noSubject : results[i]?.isError ? t.assistant.mailUnavailable(id) : t.assistant.mail(id)}
              </span>
              {m && <span className="assistant-source-meta">{[from, dayjs(m.date).format('MM-DD HH:mm')].filter(Boolean).join(' · ')}</span>}
            </span>
          ),
        };
      })}
    />
  );
}
