import {
  ArrowLeftOutlined,
  BellOutlined,
  ContainerOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  PaperClipOutlined,
  RollbackOutlined,
  ShareAltOutlined,
  StarFilled,
  StarOutlined,
  TeamOutlined,
  TranslationOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Empty, Flex, Spin, Tag, Tooltip, Typography, theme } from 'antd';
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { api, attachmentUrl, batchAction, type BatchAction, type ComposeMode, type DraftSummary, type MessageDetail, type Thread } from '../api';
import { t } from '../i18n';
import { folderLabel, formatAddress, formatSize, fromNow, fullDate, shortDate } from '../lib/format';
import { FileIcon } from '../lib/fileIcon';
import { useFolders } from '../hooks/data';
import { AddressPopover, PlaceLink } from './AddressPopover';
import { SenderAvatar } from './SenderAvatar';
import { useCompose } from './Compose';
import { EmailBody } from './EmailBody';
import { FollowUpControl, isOwnMessage } from './FollowUp';
import { UnsubscribeButton } from './Unsubscribe';
import { InsightCard } from './Insight';
import { MessageLabels } from './Labels';
import { MessageContextMenu, type MessageMenuTarget } from './MessageContextMenu';
import { TranslationView, useMessageTranslation } from './Translation';

const DRAFT_STATUS_COLOR: Record<string, string> = {
  draft: 'default',
  pending: 'gold',
  queued: 'blue',
  failed: 'red',
  rejected: 'orange',
};

/** 收件人、抄送：每个地址都能悬停查看、点击搜索 */
const addressList = (list: MessageDetail['to']) =>
  list.map((a, i) => (
    <span key={`${a.address}-${i}`}>
      {i > 0 && '，'}
      {a.name && a.address ? (
        <>
          {a.name} &lt;
          <AddressPopover address={a.address} name={a.name}>
            {a.address}
          </AddressPopover>
          &gt;
        </>
      ) : (
        <AddressPopover address={a.address} name={a.name}>
          {formatAddress(a)}
        </AddressPopover>
      )}
    </span>
  ));

const isInbox = (m: MessageDetail) => m.folderSpecialUse === '\\Inbox' || m.folder.toUpperCase() === 'INBOX';

function MessageCard({
  message,
  expanded,
  onToggle,
  onCompose,
  onContextMenu,
}: {
  message: MessageDetail;
  expanded: boolean;
  onToggle: () => void;
  onCompose: (mode: ComposeMode) => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}) {
  const { token } = theme.useToken();
  const name = message.from.name || message.from.address || t.reader.unknownSender;
  const files = message.attachments.filter((a) => !a.inline);
  const folder = folderLabel({ name: message.folder, path: message.folder, specialUse: message.folderSpecialUse });
  const tr = useMessageTranslation(message);
  const folders = useFolders();
  const folderId = folders.data?.find((f) => f.accountId === message.accountId && f.path === message.folder)?.id;

  return (
    <section className={`message-card${expanded ? ' expanded' : ''}`}>
      <Flex gap={12} align="flex-start" className="message-head" onClick={onToggle} onContextMenu={onContextMenu}>
        <SenderAvatar address={message.from.address} name={name} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Flex align="center" gap={8}>
            {message.from.name ? (
              <>
                <Typography.Text strong ellipsis style={{ minWidth: 0 }}>
                  {name}
                </Typography.Text>
                <AddressPopover address={message.from.address} name={message.from.name}>
                  <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, minWidth: 0 }}>
                    {message.from.address}
                  </Typography.Text>
                </AddressPopover>
              </>
            ) : (
              // 没有显示名时第一行就是邮箱地址本身
              <AddressPopover address={message.from.address}>
                <Typography.Text strong ellipsis style={{ minWidth: 0 }}>
                  {name}
                </Typography.Text>
              </AddressPopover>
            )}
            <Flex gap={6} align="center" style={{ marginLeft: 'auto', flex: 'none' }}>
              {message.flagged && <StarFilled style={{ color: token.colorWarning }} />}
              {(message.followUp?.status === 'open' || message.followUp?.status === 'due') && (
                <Tooltip title={message.followUp.status === 'due' ? t.reader.followUpDue : t.reader.followUpSet}>
                  <BellOutlined style={{ color: message.followUp.status === 'due' ? token.colorError : token.colorTextSecondary }} />
                </Tooltip>
              )}
              {files.length > 0 && <PaperClipOutlined style={{ color: token.colorTextSecondary }} />}
              <Tooltip title={fullDate(message.date)}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {shortDate(message.date)}
                </Typography.Text>
              </Tooltip>
            </Flex>
          </Flex>
          {expanded ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {t.reader.to}
              {message.to.length ? addressList(message.to) : '—'}
              {message.cc.length > 0 && (
                <>
                  {' · '}
                  {t.reader.cc}
                  {addressList(message.cc)}
                </>
              )}
              <Flex align="center" gap={8} wrap style={{ marginTop: 4 }}>
                <span className="message-where">
                  <PlaceLink to={`/mail?account=${message.accountId}`} title={t.reader.viewAccount}>
                    {message.accountEmail}
                  </PlaceLink>
                  {' · '}
                  <PlaceLink to={folderId ? `/mail?folder=${folderId}` : null} title={t.reader.openFolder(folder)}>
                    {folder}
                  </PlaceLink>
                </span>
                <span onClick={(e) => e.stopPropagation()}>
                  <Button
                    size="small"
                    type="text"
                    icon={<TranslationOutlined />}
                    loading={tr.loading && !tr.translation}
                    onClick={() => (tr.translation ? tr.setShowOriginal(!tr.showOriginal) : tr.translate())}
                    style={{ fontSize: 12 }}
                  >
                    {tr.loading && !tr.translation
                      ? t.reader.translating
                      : !tr.translation
                        ? t.reader.translate
                        : tr.showOriginal
                          ? t.reader.showTranslation
                          : t.reader.showOriginal}
                  </Button>
                </span>
                {isOwnMessage(message) && message.messageId && <FollowUpControl message={message} />}
                {!isOwnMessage(message) && message.unsubscribe && (
                  <UnsubscribeButton
                    target={{
                      messageId: message.id,
                      method: message.unsubscribe.method,
                      url: message.unsubscribe.url,
                      fromBody: message.unsubscribe.fromBody,
                      sender: name,
                    }}
                    unsubscribed={message.unsubscribe.unsubscribed}
                  />
                )}
              </Flex>
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary" ellipsis style={{ fontSize: 13, display: 'block' }}>
              {(message.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}
            </Typography.Text>
          )}
        </div>
      </Flex>
      {expanded && (
        <div className="message-content">
          {message.truncated && <Alert type="warning" showIcon icon={<WarningOutlined />} title={t.reader.truncated} style={{ marginBottom: 8 }} />}
          <MessageLabels messageId={message.id} threadId={message.threadId} labels={message.labels ?? []} />
          {message.insight && <InsightCard insight={message.insight} linkable />}
          {tr.showing ? (
            <TranslationView
              message={message}
              translation={tr.translation!}
              loading={tr.loading}
              onOriginal={() => tr.setShowOriginal(true)}
              onRetranslate={() => tr.translate(true)}
            />
          ) : (
            <EmailBody message={message} />
          )}
          {files.length > 0 && (
            <Flex wrap gap={8} style={{ marginTop: 12 }}>
              {files.map((a) => (
                <Button
                  key={a.index}
                  icon={<FileIcon filename={a.filename} contentType={a.contentType} />}
                  href={attachmentUrl(message.id, a.index)}
                  target="_blank"
                  style={{ maxWidth: 280 }}
                >
                  <Typography.Text ellipsis style={{ maxWidth: 180 }}>
                    {a.filename ?? t.reader.attachment(a.index + 1)}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {formatSize(a.size)}
                  </Typography.Text>
                </Button>
              ))}
            </Flex>
          )}
          <Flex gap={8} wrap style={{ marginTop: 16 }}>
            <Button icon={<RollbackOutlined />} onClick={() => onCompose('reply')}>
              {t.reader.reply}
            </Button>
            {message.to.length + message.cc.length > 1 && (
              <Button icon={<TeamOutlined />} onClick={() => onCompose('replyAll')}>
                {t.reader.replyAll}
              </Button>
            )}
            <Button icon={<ShareAltOutlined />} onClick={() => onCompose('forward')}>
              {t.reader.forward}
            </Button>
          </Flex>
        </div>
      )}
    </section>
  );
}

/** 会话里尚未发出的草稿 / 待审批邮件 */
function ThreadDrafts({ threadId }: { threadId: string }) {
  const compose = useCompose();
  const drafts = useQuery({
    queryKey: ['drafts', 'thread', threadId],
    queryFn: () => api<DraftSummary[]>(`/api/v1/drafts?thread=${encodeURIComponent(threadId)}&status=draft,pending,queued,failed,rejected`),
  });
  if (!drafts.data?.length) return null;
  return (
    <>
      {drafts.data.map((d) => (
        <Card key={d.id} size="small" style={{ marginBottom: 12, borderStyle: 'dashed' }}>
          <Flex align="center" gap={8}>
            <Tag color={DRAFT_STATUS_COLOR[d.status]}>{t.reader.draftStatus[d.status] ?? d.status}</Tag>
            {d.source !== 'web' && <Tag>{d.source.toUpperCase()}</Tag>}
            <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }} type="secondary">
              {d.snippet || t.reader.empty}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12, flex: 'none' }}>
              {fromNow(d.updatedAt)}
            </Typography.Text>
            <Button size="small" icon={<EditOutlined />} onClick={() => compose({ draftId: d.id })}>
              {d.status === 'pending' ? t.reader.approve : t.reader.continueEditing}
            </Button>
          </Flex>
        </Card>
      ))}
    </>
  );
}

export function ThreadView({ threadId, inTrash, onBack, onDone }: { threadId: string; inTrash?: boolean; onBack?: () => void; onDone?: () => void }) {
  const { token } = theme.useToken();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const compose = useCompose();
  const query = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => api<Thread>(`/api/v1/threads/${encodeURIComponent(threadId)}`),
  });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [acting, setActing] = useState<string | null>(null);
  // 邮件头部的右键菜单（正文保留浏览器自己的菜单，方便复制文字）
  const [msgMenu, setMsgMenu] = useState<MessageMenuTarget | null>(null);
  const closeMsgMenu = useCallback(() => setMsgMenu(null), []);

  // 打开会话时把未读邮件标为已读（每个会话只自动标一次，之后手动标未读不会被立刻改回）
  const markedRead = useRef(false);
  useEffect(() => {
    const unread = (query.data?.messages ?? []).filter((m) => !m.seen).map((m) => m.id);
    if (markedRead.current || !query.data) return;
    markedRead.current = true;
    if (!unread.length) return;
    batchAction(unread, 'read')
      .then(() => qc.invalidateQueries({ queryKey: ['threads'] }))
      .catch((e: Error) => message.warning(t.reader.markReadFailed(e.message)));
  }, [query.data, qc, message]);

  // done：成功后提示并离开这个会话（onDone）；返回是否成功
  const act = async (action: BatchAction, ids: number[], done?: string) => {
    if (!ids.length) return false;
    setActing(action);
    try {
      const res = await batchAction(ids, action);
      await Promise.all([qc.invalidateQueries({ queryKey: ['threads'] }), qc.invalidateQueries({ queryKey: ['thread', threadId] })]);
      if (done) {
        message.success(res.destination ? `${done}（${res.destination}）` : done);
        onDone?.();
      }
      return true;
    } catch (e) {
      message.error((e as Error).message);
      return false;
    } finally {
      setActing(null);
    }
  };

  // 默认展开最后一封和所有未读
  useEffect(() => {
    const msgs = query.data?.messages ?? [];
    if (!msgs.length) return;
    setExpanded((prev) => {
      if (prev.size && msgs.some((m) => prev.has(m.id))) return prev;
      return new Set([msgs[msgs.length - 1]!.id, ...msgs.filter((m) => !m.seen).map((m) => m.id)]);
    });
  }, [query.data]);

  if (query.isPending) {
    return (
      <Flex align="center" justify="center" style={{ height: '100%' }}>
        <Spin />
      </Flex>
    );
  }
  if (!query.data) {
    return (
      <Flex align="center" justify="center" style={{ height: '100%' }}>
        <Empty description={t.reader.notFound} />
      </Flex>
    );
  }

  const { messages, subject } = query.data;
  const last = messages[messages.length - 1]!;
  const starred = messages.some((m) => m.flagged);
  const inboxIds = messages.filter(isInbox).map((m) => m.id);
  const trashIds = messages.filter((m) => m.folderSpecialUse !== '\\Trash').map((m) => m.id);
  const purgeIds = messages.filter((m) => m.folderSpecialUse === '\\Trash').map((m) => m.id);
  // 在「已删除」里打开，或整个会话都已在「已删除」里时，删除就是彻底删除
  const purge = purgeIds.length > 0 && (inTrash || !trashIds.length);
  const purgeThread = async () => {
    const ok = await modal.confirm({
      title: t.reader.purgeTitle(purgeIds.length),
      content: t.reader.purgeContent,
      okText: t.reader.deleteForever,
      okButtonProps: { danger: true },
    });
    if (ok) await act('delete', purgeIds, t.reader.deletedForever);
  };
  const starredIds = messages.filter((m) => m.flagged).map((m) => m.id);

  return (
    <div style={{ height: '100%', overflow: 'auto', background: token.colorBgContainer }}>
      <Flex
        align="center"
        gap={12}
        style={{
          padding: onBack ? '10px 12px' : '14px 20px',
          position: 'sticky',
          top: 0,
          zIndex: 1,
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorSplit}`,
        }}
      >
        {onBack && <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} aria-label={t.reader.backToList} />}
        <Typography.Title level={4} style={{ margin: 0, flex: 1, minWidth: 0 }} ellipsis={{ tooltip: subject }}>
          {subject || t.reader.noSubject}
        </Typography.Title>
        <Flex align="center" gap={2} className="reader-actions">
          {messages.length > 1 && (
            <Typography.Text type="secondary" style={{ marginRight: 4 }}>
              {t.reader.messageCount(messages.length)}
            </Typography.Text>
          )}
          {inboxIds.length > 0 && (
            <Tooltip title={t.reader.archive}>
              <Button type="text" icon={<ContainerOutlined />} loading={acting === 'archive'} onClick={() => act('archive', inboxIds, t.reader.archived)} />
            </Tooltip>
          )}
          {purge ? (
            <Tooltip title={t.reader.deleteForever}>
              <Button type="text" danger icon={<DeleteOutlined />} loading={acting === 'delete'} onClick={purgeThread} />
            </Tooltip>
          ) : (
            <Tooltip title={t.reader.trash}>
              <Button type="text" icon={<DeleteOutlined />} loading={acting === 'trash'} onClick={() => act('trash', trashIds, t.reader.trashed)} />
            </Tooltip>
          )}
          <Tooltip title={t.reader.markUnread}>
            <Button type="text" icon={<EyeInvisibleOutlined />} loading={acting === 'unread'} onClick={() => act('unread', [last.id], t.reader.markedUnread)} />
          </Tooltip>
          <Tooltip title={starred ? t.reader.unstar : t.reader.star}>
            <Button
              type="text"
              icon={starred ? <StarFilled style={{ color: token.colorWarning }} /> : <StarOutlined />}
              loading={acting === 'star' || acting === 'unstar'}
              onClick={() => (starred ? act('unstar', starredIds) : act('star', [last.id]))}
            />
          </Tooltip>
          <Tooltip title={t.reader.downloadEml}>
            <Button type="text" icon={<DownloadOutlined />} href={`/api/v1/messages/${last.id}/raw`} />
          </Tooltip>
        </Flex>
      </Flex>
      <div style={{ padding: onBack ? '4px 8px 16px' : '8px 20px 24px', maxWidth: 960, margin: '0 auto' }}>
        {messages.map((m) => (
          <MessageCard
            key={m.id}
            message={m}
            onCompose={(mode) => compose({ mode, sourceMessageId: m.id })}
            onContextMenu={(e) => {
              if (e.shiftKey) return;
              e.preventDefault();
              setMsgMenu({ x: e.clientX, y: e.clientY, message: m });
            }}
            expanded={expanded.has(m.id)}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(m.id)) next.delete(m.id);
                else next.add(m.id);
                return next;
              })
            }
          />
        ))}
        <ThreadDrafts threadId={threadId} />
      </div>
      <MessageContextMenu
        target={msgMenu}
        onClose={closeMsgMenu}
        inTrash={inTrash}
        count={messages.length}
        allExpanded={messages.every((m) => expanded.has(m.id))}
        onExpandAll={(open) => setExpanded(new Set(open ? messages.map((m) => m.id) : []))}
        act={act}
        onPurge={async (m) => {
          const ok = await modal.confirm({
            title: t.reader.purgeTitle(1),
            content: t.reader.purgeContent,
            okText: t.reader.deleteForever,
            okButtonProps: { danger: true },
          });
          if (!ok) return;
          // 会话只剩这一封时离开会话，否则留在这里
          if (messages.length === 1) await act('delete', [m.id], t.reader.deletedForever);
          else if (await act('delete', [m.id])) message.success(t.reader.deletedForever);
        }}
      />
    </div>
  );
}
