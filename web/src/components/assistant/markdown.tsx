import { Actions, CodeHighlighter } from '@ant-design/x';
import type { ComponentProps } from '@ant-design/x-markdown';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import { Children, isValidElement, type ReactNode } from 'react';
import { fetchMessage, messageQueryKey } from '../AssistantParts';
import { t } from '../../i18n';

/**
 * 助手回答里 XMarkdown 用到的自定义渲染。
 * MARKDOWN_COMPONENTS 定义在模块顶层，引用永远不变：流式输出时每来一块都会重新解析，
 * components 一变，里面的链接、代码块就会整个重新挂载，看起来会闪。
 */

/**
 * 模型偶尔会把 [#123] 包进 Markdown 链接，统一改成内部链接 #msg-123。
 * 流式输出时末尾还没写完的引用（如 `[#36`）先藏起来，免得先闪一下原文再变成标签。
 */
export function withCitations(text: string, streaming = false) {
  const body = streaming ? text.replace(/\[#?\d*$/, '') : text;
  return body.replace(/\[([^\]]*?)\s*\[#(\d+)\]\]\([^)]*\)/g, '$1 [#$2]').replace(/\[#(\d+)\](?!\()/g, '[#$1](#msg-$1)');
}

type CiteInfo = { subject: string; from?: string | null; date?: string };

/**
 * 在 React Query 已有的缓存里找邮件主题：先看单封邮件（引用列表、点开过的），
 * 再翻列表类数据（邮件列表、会话列表、会话详情）。只在悬停时调用，找不到才去请求。
 */
function findCached(qc: QueryClient, id: number): CiteInfo | null {
  const detail = qc.getQueryData<{ subject: string; from: { name: string | null; address: string | null }; date: string }>(messageQueryKey(id));
  if (detail) return { subject: detail.subject, from: detail.from.name || detail.from.address, date: detail.date };
  let found: CiteInfo | null = null;
  const visit = (v: unknown, depth: number) => {
    if (found || depth > 5 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 500)) visit(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const from = o.from as { name?: string | null; address?: string | null } | undefined;
    if (typeof o.subject === 'string' && (o.id === id || o.latestMessageId === id)) {
      found = { subject: o.subject, from: from?.name || from?.address, date: (o.date ?? o.lastDate) as string | undefined };
      return;
    }
    for (const x of Object.values(o)) visit(x, depth + 1);
  };
  for (const q of qc.getQueryCache().getAll()) {
    visit(q.state.data, 0);
    if (found) break;
  }
  return found;
}

/** 悬停提示的内容：只有打开提示时才会渲染，缓存里没有时才请求这一封 */
function CiteTooltip({ id }: { id: number }) {
  const qc = useQueryClient();
  const cached = findCached(qc, id);
  const q = useQuery({ queryKey: messageQueryKey(id), queryFn: () => fetchMessage(id), enabled: !cached, staleTime: Infinity, retry: false });
  const info: CiteInfo | null = cached ?? (q.data ? { subject: q.data.subject, from: q.data.from.name || q.data.from.address, date: q.data.date } : null);
  if (!info) return <span>{q.isError ? t.assistant.citeUnavailable : t.common.loading}</span>;
  return (
    <div className="assistant-cite-tip">
      <div className="assistant-cite-tip-subject">{info.subject || t.assistant.noSubject}</div>
      {(info.from || info.date) && (
        <div className="assistant-cite-tip-meta">{[info.from, info.date && dayjs(info.date).format('MM-DD HH:mm')].filter(Boolean).join(' · ')}</div>
      )}
    </div>
  );
}

/** 邮件引用：小标签显示 #123，悬停看主题，点击跳到对应会话 */
function CitationTag({ id, onOpen }: { id: number; onOpen?: (id: number) => void }) {
  return (
    <Tooltip title={<CiteTooltip id={id} />} mouseEnterDelay={0.25}>
      <a
        href={`#msg-${id}`}
        className="assistant-cite"
        onClick={(e) => {
          e.preventDefault();
          onOpen?.(id);
        }}
      >
        #{id}
      </a>
    </Tooltip>
  );
}

/** 邮件引用点开会话，其他链接新窗口打开 */
function MarkdownLink({ href, children, onOpenMessage }: ComponentProps<{ href?: string; onOpenMessage?: (id: number) => void }>) {
  const target = typeof href === 'string' ? href : undefined;
  const id = target?.match(/^#msg-(\d+)$/)?.[1];
  if (id) return <CitationTag id={Number(id)} onOpen={onOpenMessage} />;
  return (
    <a href={target} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** 把解析出来的子节点还原成纯文本（代码块内容） */
function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? textOf(c.props.children) : ''))
    .join('');
}

/** 代码：行内保持原样；代码块带语言名和复制按钮，有语言时高亮 */
function CodeBlock({ children, block, lang, streamStatus }: ComponentProps) {
  if (!block) return <code>{children}</code>;
  let code = textOf(children).replace(/\n$/, '');
  // 结束围栏正在到达时，开头的一两个反引号会先被当成代码内容，流式中先去掉
  if (streamStatus === 'loading') code = code.replace(/\n`{1,3}$/, '');
  if (!code) return null;
  if (lang)
    return (
      <CodeHighlighter
        className="assistant-code"
        lang={lang}
        // 不用内置的浅色主题，配色交给 styles.css，深色模式下也正常
        highlightProps={{ useInlineStyles: false }}
      >
        {code}
      </CodeHighlighter>
    );
  // 没写语言的代码块不需要高亮，但同样给出标题栏和复制
  return (
    <div className="assistant-code assistant-code-plain">
      <div className="assistant-code-header">
        <Typography.Text type="secondary">{t.assistant.code}</Typography.Text>
        <Actions.Copy text={code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** 代码块外层的 <pre> 由 CodeBlock 自己处理，这里只透传 */
function PreBlock({ children }: ComponentProps) {
  return <>{children}</>;
}

/** 表格包一层可横向滚动的容器，窄抽屉里不撑破布局 */
function TableBlock({ children }: ComponentProps) {
  return (
    <div className="assistant-table">
      <table>{children}</table>
    </div>
  );
}

export const MARKDOWN_COMPONENTS = {
  a: MarkdownLink as never,
  code: CodeBlock as never,
  pre: PreBlock as never,
  table: TableBlock as never,
};
