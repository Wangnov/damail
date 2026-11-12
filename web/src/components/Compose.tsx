import {
  BellOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  CloudUploadOutlined,
  CompressOutlined,
  ContactsOutlined,
  DeleteOutlined,
  DownOutlined,
  ExclamationCircleOutlined,
  ExpandOutlined,
  LoadingOutlined,
  MessageOutlined,
  PaperClipOutlined,
  PictureOutlined,
  RobotOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Collapse,
  DatePicker,
  Dropdown,
  Flex,
  Form,
  Grid,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { api, uploadDraftAttachment, type Account, type Address, type ComposeMode, type Draft } from '../api';
import { t } from '../i18n';
import { useAccounts } from '../hooks/data';
import { FileIcon } from '../lib/fileIcon';
import { formatAddress, formatSendAt, formatSize, fullDate } from '../lib/format';
import { useNavigate } from 'react-router';
import { FOLLOW_UP_DAYS } from './FollowUp';
import { ContactPicker } from './ContactPicker';
import { HtmlPreview, HtmlSourceEditor } from './HtmlSource';
import { SignatureModal } from './SignatureModal';
import { htmlToText, prettyHtml } from '../lib/htmlText';
import { isImageFile } from '../lib/inlineImage';
import { RichEditor, textToHtml } from './RichEditor';

type OpenOptions = { draftId: number } | { mode: ComposeMode; sourceMessageId?: number; accountId?: number };

const ComposeContext = createContext<(opts: OpenOptions) => void>(() => {});

export const useCompose = () => useContext(ComposeContext);

const EDITABLE = new Set(['draft', 'pending', 'failed', 'rejected']);

/** 不能再编辑的邮件（待发送、发送中、已发送）：按读信的样子展示，不用灰掉的表单 */
function DraftDetail({ draft, scheduled }: { draft: Draft; scheduled: boolean }) {
  const accounts = useAccounts();
  const account = accounts.data?.find((a) => a.id === draft.accountId);
  const list = (xs: Address[]) => xs.map(formatAddress).join(t.compose.listSep);
  const time =
    draft.status === 'sent' && draft.sentAt
      ? { label: t.compose.sentAt, value: fullDate(draft.sentAt) }
      : scheduled
        ? { label: t.compose.scheduled, value: t.compose.scheduledValue(formatSendAt(draft.sendAt!), fullDate(draft.sendAt!)) }
        : { label: t.compose.updatedAt, value: fullDate(draft.updatedAt) };
  const rows: Array<[string, ReactNode]> = [
    [t.compose.from, account ? `${account.name} <${account.email}>` : '-'],
    [t.compose.to, list(draft.to) || t.compose.noRecipients],
    ...(draft.cc.length ? ([[t.compose.cc, list(draft.cc)]] as Array<[string, ReactNode]>) : []),
    ...(draft.bcc.length ? ([[t.compose.bcc, list(draft.bcc)]] as Array<[string, ReactNode]>) : []),
    [time.label, time.value],
    [t.compose.source_, draft.note ? `${t.compose.source[draft.source]} · ${draft.note}` : t.compose.source[draft.source]],
  ];
  return (
    <div className="draft-detail">
      <Typography.Title level={5} style={{ margin: '0 0 12px' }}>
        {draft.subject || t.compose.noSubject}
      </Typography.Title>
      <dl className="draft-detail-meta">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="draft-detail-body">
        {draft.bodyFormat === 'html' && draft.bodyHtml ? (
          <HtmlPreview html={draft.bodyHtml} className="html-preview draft-detail-html" />
        ) : (
          <RichEditor value={draft.bodyHtml ?? textToHtml(draft.body)} editable={false} />
        )}
      </div>
      {draft.attachments.length > 0 && (
        <Flex wrap gap={6} style={{ marginTop: 12 }}>
          {draft.attachments.map((a) => (
            <Tag key={a.path} icon={<FileIcon filename={a.filename} contentType={a.contentType} />}>
              {a.filename} · {formatSize(a.size)}
            </Tag>
          ))}
        </Flex>
      )}
      {draft.quoteText && draft.includeQuote && (
        <Collapse
          size="small"
          ghost
          style={{ marginTop: 8 }}
          items={[
            {
              key: 'quote',
              label: <Typography.Text type="secondary">{t.compose.viewQuote(draft.mode === 'forward')}</Typography.Text>,
              children: (
                <pre style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 280, overflow: 'auto', fontSize: 12, opacity: 0.75 }}>{draft.quoteText}</pre>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

type Values = {
  accountId: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyHtml: string;
  bodyFormat: 'rich' | 'html';
  includeSignature: boolean;
  includeQuote: boolean;
  followUpDays: number | null;
};

/** 收件人输入：回车 / 逗号 / 分号分隔，失焦时把没回车的地址也收进来，并按历史联系人联想 */
function RecipientSelect({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value?: string[];
  onChange?: (v: string[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [search, setSearch] = useState('');
  const contacts = useQuery({
    queryKey: ['contacts', search.trim()],
    queryFn: () => api<Address[]>(`/api/v1/contacts?q=${encodeURIComponent(search.trim())}`),
    enabled: search.trim().length >= 1,
    staleTime: 60_000,
  });
  // 「a@x.com, b@y.com」按分隔符拆开后会带空格甚至只剩空格，去掉空白和重复的
  const set = (next: string[]) => onChange?.([...new Set(next.map((s) => s.trim()).filter(Boolean))]);
  const commit = () => {
    const text = search.trim();
    if (text && !(value ?? []).includes(text)) set([...(value ?? []), text]);
    setSearch('');
  };
  return (
    <Select
      mode="tags"
      value={value}
      onChange={set}
      placeholder={placeholder}
      autoFocus={autoFocus}
      variant="borderless"
      suffixIcon={null}
      tokenSeparators={[',', ';', '，', '；', '\n']}
      showSearch={{ searchValue: search, onSearch: setSearch, filterOption: false }}
      onBlur={commit}
      notFoundContent={null}
      options={(search.trim() ? (contacts.data ?? []) : []).map((a) => ({ value: formatAddress(a), label: a.alias ? `${a.alias} · ${formatAddress(a)}` : formatAddress(a) }))}
      style={{ width: '100%' }}
    />
  );
}

/** 发件人：名字和地址相同（或没有名字）时只显示地址，否则地址弱化显示在名字后面 */
function accountLabel(a: Pick<Account, 'name' | 'email'>) {
  if (!a.name || a.name.trim().toLowerCase() === a.email.toLowerCase()) return a.email;
  return (
    <>
      {a.name}
      <span className="compose-from-email">{a.email}</span>
    </>
  );
}

const SEND_KEYS = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ Enter' : 'Ctrl + Enter';

/** 写信头部的一行：左边标签，点标签聚焦这一行的输入框 */
function FieldRow({ label, className, children, extra }: { label: string; className?: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className={`compose-row${className ? ` ${className}` : ''}`}>
      <span className="compose-label" onMouseDown={(e) => (e.preventDefault(), e.currentTarget.parentElement?.querySelector<HTMLInputElement>('input')?.focus())}>
        {label}
      </span>
      <div className="compose-field">{children}</div>
      {extra}
    </div>
  );
}

function toBody(v: Partial<Values>) {
  return {
    accountId: v.accountId,
    to: v.to,
    cc: v.cc,
    bcc: v.bcc,
    subject: v.subject,
    body: v.body,
    bodyHtml: v.bodyHtml || null,
    bodyFormat: v.bodyFormat,
    includeSignature: v.includeSignature,
    includeQuote: v.includeQuote,
    followUpDays: v.followUpDays,
  };
}

/** 定时发送的快捷选项：今天傍晚（还没过的话）、明早、明天下午、下周一早上 */
function schedulePresets(now = dayjs()) {
  const list: Array<{ key: string; label: string; at: Dayjs }> = [];
  const evening = now.hour(18).minute(0).second(0);
  if (evening.diff(now, 'minute') > 30) list.push({ key: 'evening', label: t.compose.presets.evening, at: evening });
  const tomorrow = now.add(1, 'day').second(0);
  list.push({ key: 'tomorrow-am', label: t.compose.presets.tomorrowAm, at: tomorrow.hour(8).minute(0) });
  list.push({ key: 'tomorrow-pm', label: t.compose.presets.tomorrowPm, at: tomorrow.hour(14).minute(0) });
  const monday = now.add(((8 - now.day()) % 7) || 7, 'day').hour(9).minute(0).second(0);
  list.push({ key: 'monday', label: t.compose.presets.monday(monday.format(t.compose.presets.mondayDate)), at: monday });
  return list;
}


function ComposeDrawer({
  draftId,
  fresh,
  onClosed,
  onSent,
}: {
  draftId: number;
  fresh: boolean;
  onClosed: () => void;
  onSent: (d: Draft, scheduled?: boolean) => void;
}) {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const accounts = useAccounts();
  const narrow = !Grid.useBreakpoint().md;
  const [form] = Form.useForm<Values>();
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState<'send' | 'reject' | 'delete' | null>(null);
  const [uploading, setUploading] = useState(0);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // 正在从通讯录给哪一栏挑人
  const [picking, setPicking] = useState<'to' | 'cc' | 'bcc' | null>(null);
  const [dropInline, setDropInline] = useState(false);
  const [signatureOpen, setSignatureOpen] = useState(false);
  // 签名在邮箱设置里（只有网页登录能读到），换发件邮箱时跟着换
  const adminAccounts = useQuery({ queryKey: ['admin-accounts'], queryFn: () => api<Account[]>('/api/admin/accounts'), staleTime: 60_000 });
  const dragDepth = useRef(0);

  const query = useQuery({
    queryKey: ['draft', draftId],
    queryFn: () => api<Draft>(`/api/v1/drafts/${draftId}`),
    // 表单只在挂载时读取一次初始值：打开期间不重复拉取，关闭后丢弃缓存，下次打开拿最新内容
    staleTime: Infinity,
    gcTime: 0,
  });
  const draft = query.data;

  // 自动保存：停止输入 1 秒后保存，请求串行执行
  const dirty = useRef(false);
  const touched = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  // 最近一次保存后服务器返回的草稿
  const saved = useRef<Draft | null>(null);
  const save = useCallback(() => {
    window.clearTimeout(timer.current);
    // 上一次保存失败不能卡住后面的保存，否则改正错误后也一直报旧的错
    chain.current = chain.current.catch(() => {}).then(async () => {
      if (!dirty.current) return;
      dirty.current = false;
      setSaveState('saving');
      try {
        saved.current = await api<Draft>(`/api/v1/drafts/${draftId}`, { method: 'PATCH', body: toBody(form.getFieldsValue()) });
        setSaveState('saved');
      } catch (e) {
        dirty.current = true;
        setSaveState('error');
        throw e;
      }
    });
    return chain.current;
  }, [draftId, form]);

  useEffect(() => () => void (dirty.current && save().catch(() => {})), [save]);

  useEffect(() => {
    // 草稿加载后，已有抄送 / 密送时展开对应输入框
    if (draft?.cc.length) setShowCc(true);
    if (draft?.bcc.length) setShowBcc(true);
  }, [draft]);

  const editable = draft ? EDITABLE.has(draft.status) : false;

  /** 点「抄送 / 密送」后展开那一行并聚焦（草稿里本来就有的不抢焦点） */
  const [revealed, setRevealed] = useState<'cc' | 'bcc' | null>(null);
  const reveal = (which: 'cc' | 'bcc') => {
    (which === 'cc' ? setShowCc : setShowBcc)(true);
    setRevealed(which);
  };

  const close = async () => {
    try {
      await save();
    } catch {
      // 保存失败也允许关闭，内容留在服务器上次保存的版本
    }
    // 打开后什么都没改就关掉，不留空草稿
    if (fresh && !touched.current && draft?.status === 'draft') {
      await api(`/api/v1/drafts/${draftId}`, { method: 'DELETE' }).catch(() => {});
    } else if (touched.current) {
      void qc.invalidateQueries({ queryKey: ['drafts'] });
    }
    setOpen(false);
  };

  /** 表单有改动：1 秒后自动保存 */
  const markChanged = () => {
    dirty.current = true;
    touched.current = true;
    setSaveState('idle');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save().catch(() => {}), 1000);
  };
  const followUpDays = Form.useWatch('followUpDays', form) ?? null;

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [customAt, setCustomAt] = useState<Dayjs | null>(null);

  const send = async (sendAt?: Dayjs) => {
    const v = form.getFieldsValue();
    if (!v.to?.length && !v.cc?.length && !v.bcc?.length) return message.warning(t.compose.needRecipients);
    if (!v.subject?.trim() && !v.body?.trim()) return message.warning(t.compose.emptyMail);
    setBusy('send');
    try {
      dirty.current = true;
      await save();
      // 保存后的版本号随发送请求带上：保存之后草稿又被改过（比如 Agent 改了内容），服务器会拒绝发送
      const latest = saved.current;
      if (!latest) throw new Error(t.compose.draftChanged);
      // 附件不在表单里，保存不会覆盖：和界面上显示的不一致就说明审阅期间被改过
      const shown = qc.getQueryData<Draft>(['draft', draftId])?.attachments ?? [];
      if (latest.attachments.map((a) => a.path).join('\n') !== shown.map((a) => a.path).join('\n')) {
        qc.setQueryData<Draft>(['draft', draftId], (old) => (old ? { ...old, attachments: latest.attachments } : old));
        throw new Error(t.compose.draftChanged);
      }
      const d = await api<Draft>(`/api/v1/drafts/${draftId}/send`, {
        method: 'POST',
        body: { revision: latest.revision, ...(sendAt ? { sendAt: sendAt.toISOString() } : {}) },
      });
      onSent({ ...d, sendDelaySec: draft?.sendDelaySec }, !!sendAt);
      touched.current = true;
      setScheduleOpen(false);
      setOpen(false);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    setBusy('reject');
    try {
      await api(`/api/v1/drafts/${draftId}/reject`, { method: 'POST', body: {} });
      message.success(t.compose.rejected);
      touched.current = true;
      setOpen(false);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    setBusy('delete');
    try {
      window.clearTimeout(timer.current);
      dirty.current = false;
      await chain.current.catch(() => {});
      await api(`/api/v1/drafts/${draftId}`, { method: 'DELETE' });
      touched.current = true;
      setOpen(false);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const cancelQueued = async () => {
    try {
      await api(`/api/v1/drafts/${draftId}/cancel`, { method: 'POST' });
      await query.refetch();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const upload = async (file: File) => {
    setUploading((n) => n + 1);
    try {
      const d = await uploadDraftAttachment(draftId, file);
      qc.setQueryData<Draft>(['draft', draftId], (old) => (old ? { ...old, attachments: d.attachments } : old));
      touched.current = true;
    } catch (e) {
      message.error(`${file.name}：${(e as Error).message}`);
    } finally {
      setUploading((n) => n - 1);
    }
  };

  // 把文件拖进弹窗任意位置都能添加附件；图片拖到正文里则插入正文；拖动文字交给编辑器
  const overEditorWithImages = (e: DragEvent) =>
    !!(e.target as Element | null)?.closest?.('.ProseMirror') &&
    Array.from(e.dataTransfer.items).every((i) => i.kind === 'file' && /^image\/(png|jpe?g|gif|webp)$/i.test(i.type));
  const hasFiles = (e: DragEvent) => editable && e.dataTransfer.types.includes('Files');
  const dropHandlers = {
    onDragEnterCapture: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current++;
      setDragging(true);
    },
    onDragOverCapture: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDropInline(overEditorWithImages(e));
    },
    onDragLeaveCapture: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (--dragDepth.current <= 0) (dragDepth.current = 0), setDragging(false);
    },
    onDropCapture: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // 图片拖到正文里：交给编辑器插到正文，不当附件
      if (overEditorWithImages(e) && Array.from(e.dataTransfer.files).every(isImageFile)) {
        dragDepth.current = 0;
        setDragging(false);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      dragDepth.current = 0;
      setDragging(false);
      for (const f of Array.from(e.dataTransfer.files)) void upload(f);
    },
  };

  const removeAttachment = async (index: number) => {
    try {
      const d = await api<Draft>(`/api/v1/drafts/${draftId}/attachments/${index}`, { method: 'DELETE' });
      qc.setQueryData<Draft>(['draft', draftId], (old) => (old ? { ...old, attachments: d.attachments } : old));
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  // 超过一分钟以后才发的视为定时发送，区别于发送后的撤销窗口
  const scheduled = draft?.status === 'queued' && !!draft.sendAt && dayjs(draft.sendAt).diff(dayjs(), 'second') > 60;
  // 标题按状态写，草稿才按写信方式（回复、转发……）
  const STATUS_TITLE: Partial<Record<Draft['status'], string>> = {
    pending: t.compose.statusTitle.pending,
    rejected: t.compose.statusTitle.rejected,
    failed: t.compose.statusTitle.failed,
    queued: scheduled ? t.compose.statusTitle.scheduled : t.compose.statusTitle.queued,
    sending: t.compose.statusTitle.sending,
    sent: t.compose.statusTitle.sent,
  };
  const title = draft ? (STATUS_TITLE[draft.status] ?? t.compose.mode[draft.mode]) : t.compose.mode.new;
  const saveStatus = {
    idle: null,
    saving: { icon: <LoadingOutlined />, text: t.compose.saving },
    saved: { icon: <CheckOutlined />, text: t.compose.saved },
    error: { icon: <ExclamationCircleOutlined />, text: t.compose.saveFailed },
  }[saveState];
  const singleAccount = (accounts.data?.length ?? 0) <= 1;

  const alerts = draft && (
    <>
      {draft.status === 'pending' && (
        <Alert type="info" showIcon icon={<RobotOutlined />} title={t.compose.pendingFrom(t.compose.source[draft.source])} description={draft.note || undefined} />
      )}
      {draft.status === 'failed' && <Alert type="error" showIcon title={t.compose.failedAlert} description={draft.error || undefined} />}
      {draft.status === 'rejected' && <Alert type="warning" showIcon title={t.compose.rejectedAlert} description={draft.error || undefined} />}
      {(draft.status === 'queued' || draft.status === 'sending') && (
        <Alert
          type="info"
          showIcon
          icon={scheduled ? <ClockCircleOutlined /> : undefined}
          title={scheduled ? t.compose.willSendAt(formatSendAt(draft.sendAt!)) : draft.status === 'queued' ? t.compose.sendingSoon : t.compose.sendingNow}
        />
      )}
      {/* 已发出但有提示（例如没能存进「已发送」文件夹） */}
      {draft.status === 'sent' && draft.error && <Alert type="warning" showIcon title={draft.error} />}
    </>
  );

  const saveBadge = saveStatus && (
    <span className={`compose-save compose-save-${saveState}`} aria-live="polite">
      {saveStatus.icon}
      {saveStatus.text}
    </span>
  );
  const headIcons = (
    <span className="cv-head-icons">
      {!narrow && (
        <Tooltip title={maximized ? t.compose.restore : t.compose.maximize} mouseEnterDelay={0.5}>
          <Button
            type="text"
            size="small"
            icon={maximized ? <CompressOutlined /> : <ExpandOutlined />}
            aria-label={maximized ? t.compose.restore : t.compose.maximize}
            onClick={() => setMaximized((m) => !m)}
          />
        </Tooltip>
      )}
      <Button type="text" size="small" icon={<CloseOutlined />} aria-label={t.common.close} onClick={() => void close()} />
    </span>
  );
  const sendLabel = draft?.status === 'pending' ? t.compose.approveAndSend : draft?.status === 'failed' ? t.compose.resend : t.compose.send;
  const sendGroup = (
    <Space.Compact className="cv-send">
      <Tooltip title={SEND_KEYS} mouseEnterDelay={0.5}>
        <Button type="primary" icon={<SendOutlined />} loading={busy === 'send'} disabled={uploading > 0} onClick={() => void send()}>
          {sendLabel}
        </Button>
      </Tooltip>
      <Dropdown
        trigger={['click']}
        disabled={busy === 'send' || uploading > 0}
        menu={{
          items: [
            { key: 'title', type: 'group', label: t.compose.schedule },
            ...schedulePresets().map((p) => ({ key: p.key, label: p.label, icon: <ClockCircleOutlined /> })),
            { type: 'divider' },
            { key: 'custom', label: t.compose.pickDateTime },
          ],
          onClick: ({ key }) => {
            if (key === 'custom') {
              setCustomAt(dayjs().add(1, 'hour').minute(0).second(0));
              return setScheduleOpen(true);
            }
            const p = schedulePresets().find((x) => x.key === key);
            if (p) void send(p.at);
          },
        }}
      >
        <Button type="primary" icon={<DownOutlined />} aria-label={t.compose.schedule} />
      </Dropdown>
    </Space.Compact>
  );
  const rejectButton = draft?.status === 'pending' && (
    <Popconfirm title={t.compose.rejectTitle} description={t.compose.rejectDesc} okText={t.compose.reject} onConfirm={reject}>
      <Button loading={busy === 'reject'}>{t.compose.reject}</Button>
    </Popconfirm>
  );
  const attachButton = (
    <Upload multiple showUploadList={false} customRequest={({ file, onSuccess }) => void upload(file as File).then(() => onSuccess?.(null))}>
      <Tooltip title={t.compose.attachTip} mouseEnterDelay={0.5}>
        <Button type="text" className="compose-tool" icon={<PaperClipOutlined />} loading={uploading > 0} aria-label={t.compose.attach}>
          {narrow ? null : t.compose.attach}
        </Button>
      </Tooltip>
    </Upload>
  );
  const followSelect = (
    <Tooltip title={t.compose.followUpTip} mouseEnterDelay={0.5}>
      <Select
        variant="borderless"
        className={`compose-tool compose-follow${followUpDays ? ' on' : ''}`}
        value={followUpDays ?? 0}
        onChange={(v: number) => {
          form.setFieldValue('followUpDays', v || null);
          markChanged();
        }}
        prefix={<BellOutlined />}
        popupMatchSelectWidth={false}
        options={[{ value: 0, label: t.compose.noFollowUp }, ...FOLLOW_UP_DAYS.map((d) => ({ value: d.value, label: t.compose.followUpAfter(d.label) }))]}
        aria-label={t.compose.followUpAria}
      />
    </Tooltip>
  );
  const trashButton = draft && draft.status !== 'queued' && draft.status !== 'sending' && (
    <Popconfirm
      title={draft.status === 'sent' ? t.compose.deleteSentTitle : t.compose.deleteDraftTitle}
      description={draft.status === 'sent' ? t.compose.deleteSentDesc : undefined}
      okText={t.common.delete}
      okButtonProps={{ danger: true }}
      onConfirm={discard}
    >
      <Tooltip title={draft.status === 'sent' ? t.compose.deleteRecord : t.compose.deleteDraft} mouseEnterDelay={0.5}>
        <Button
          type="text"
          className="compose-tool compose-trash"
          icon={<DeleteOutlined />}
          loading={busy === 'delete'}
          aria-label={draft.status === 'sent' ? t.compose.deleteRecord : t.compose.deleteDraft}
        />
      </Tooltip>
    </Popconfirm>
  );
  // 不能编辑时（待发送、已发送…）底栏的操作
  const readonlyActions = draft && (
    <>
      {draft.status === 'queued' && <Button onClick={cancelQueued}>{scheduled ? t.compose.cancelSchedule : t.compose.undoSend}</Button>}
      {draft.status === 'sent' && draft.threadId && (
        <Button
          icon={<MessageOutlined />}
          onClick={() => {
            setOpen(false);
            navigate(`/mail?view=all&thread=${encodeURIComponent(draft.threadId!)}`);
          }}
        >
          {t.compose.viewInThread}
        </Button>
      )}
    </>
  );

  const fromSelect = (
    <Form.Item name="accountId" noStyle>
      <Select
        variant="borderless"
        className="compose-from"
        suffixIcon={singleAccount ? null : undefined}
        open={singleAccount ? false : undefined}
        popupMatchSelectWidth={false}
        options={accounts.data?.map((a) => ({ value: a.id, label: accountLabel(a) }))}
      />
    </Form.Item>
  );
  const recipients = (which: 'to' | 'cc' | 'bcc') => (
    <Form.Item name={which} noStyle>
      <RecipientSelect autoFocus={which === 'to' ? editable && draft?.mode === 'new' : revealed === which} />
    </Form.Item>
  );
  const contactsButton = (which: 'to' | 'cc' | 'bcc') => (
    <Tooltip title={t.compose.pickContacts} mouseEnterDelay={0.5}>
      <Button type="text" size="small" className="compose-contacts" icon={<ContactsOutlined />} aria-label={t.compose.pickContacts} onClick={() => setPicking(which)} />
    </Tooltip>
  );
  const ccToggles = (
    <span className="compose-row-extra">
      {contactsButton('to')}
      {!showCc && (
        <button type="button" onClick={() => reveal('cc')}>
          {t.compose.cc}
        </button>
      )}
      {!showBcc && (
        <button type="button" onClick={() => reveal('bcc')}>
          {t.compose.bcc}
        </button>
      )}
    </span>
  );
  const bodyFormat = (Form.useWatch('bodyFormat', form) as Values['bodyFormat'] | undefined) ?? draft?.bodyFormat ?? 'rich';
  const toSource = () => {
    form.setFieldsValue({ bodyFormat: 'html', bodyHtml: prettyHtml(form.getFieldValue('bodyHtml') ?? '') });
    markChanged();
  };
  const toRich = () =>
    modal.confirm({
      title: t.compose.backToRichTitle,
      content: t.compose.backToRichDesc,
      okText: t.compose.backToRich,
      onOk: () => {
        form.setFieldValue('bodyFormat', 'rich');
        markChanged();
      },
    });
  const editor =
    bodyFormat === 'html' ? (
      <Form.Item name="bodyHtml" noStyle>
        <HtmlSourceEditor
          narrow={narrow}
          onExit={toRich}
          onChange={(html) => {
            form.setFieldsValue({ bodyHtml: html, body: htmlToText(html) });
            markChanged();
          }}
        />
      </Form.Item>
    ) : (
      <Form.Item name="bodyHtml" noStyle>
        <RichEditor
          bare
          editable={editable}
          placeholder={t.compose.body}
          autoFocus={editable && draft?.mode !== 'new'}
          onTextChange={(text) => form.setFieldValue('body', text)}
          onSourceMode={toSource}
        />
      </Form.Item>
    );

  const accountId = Form.useWatch('accountId', form) ?? draft?.accountId;
  const sigAccount = adminAccounts.data?.find((a) => a.id === accountId) ?? null;
  const includeSignature = (Form.useWatch('includeSignature', form) as boolean | undefined) ?? draft?.includeSignature ?? true;
  const signature = (
    <div className="compose-signature">
      {sigAccount?.signatureHtml ? (
        <>
          <div className="compose-signature-bar">
            <Form.Item name="includeSignature" valuePropName="checked" noStyle>
              <Checkbox>{t.compose.includeSignature}</Checkbox>
            </Form.Item>
            <button type="button" className="compose-link" onClick={() => setSignatureOpen(true)}>
              {t.compose.editSignature}
            </button>
          </div>
          {includeSignature && (
            <div className="compose-signature-body">
              <span className="compose-signature-dash">--</span>
              <RichEditor key={`${sigAccount.id}:${sigAccount.signatureHtml}`} value={sigAccount.signatureHtml} editable={false} />
            </div>
          )}
        </>
      ) : (
        sigAccount && (
          <button type="button" className="compose-link" onClick={() => setSignatureOpen(true)}>
            + {t.compose.addSignature}
          </button>
        )
      )}
    </div>
  );
  const attachments = draft && draft.attachments.length > 0 && (
    <div className="compose-attachments">
      {draft.attachments.map((a, i) => (
        <Tag
          key={a.path}
          className="compose-attachment"
          icon={<FileIcon filename={a.filename} contentType={a.contentType} />}
          closable={editable}
          onClose={(e) => {
            e.preventDefault();
            void removeAttachment(i);
          }}
        >
          <span className="compose-attachment-name">{a.filename}</span>
          <span className="compose-attachment-size">{formatSize(a.size)}</span>
        </Tag>
      ))}
    </div>
  );
  const quote = draft?.quoteText && (
    <div className="compose-quote">
      <Form.Item name="includeQuote" valuePropName="checked" noStyle>
        <Checkbox>{t.compose.includeQuote(draft.mode === 'forward')}</Checkbox>
      </Form.Item>
      <Collapse
        size="small"
        ghost
        items={[
          {
            key: 'quote',
            label: <Typography.Text type="secondary">{t.compose.viewQuote(draft.mode === 'forward')}</Typography.Text>,
            children: (
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 280, overflow: 'auto', fontSize: 12, opacity: 0.75 }}>{draft.quoteText}</pre>
            ),
          },
        ]}
      />
    </div>
  );
  const head = (
    <div className="cv-head">
      <span className="cv-title">{title}</span>
      {saveBadge}
      {headIcons}
    </div>
  );

  // 头部字段一张卡片，正文一张卡片
  const editing = draft && editable && (
    <div className="cv-scroll">
      <div className="cv-card cv-fields">
        <FieldRow label={t.compose.from}>{fromSelect}</FieldRow>
        <FieldRow label={t.compose.to} extra={ccToggles}>
          {recipients('to')}
        </FieldRow>
        {showCc && (
          <FieldRow label={t.compose.cc} className="compose-row-cc" extra={<span className="compose-row-extra">{contactsButton('cc')}</span>}>
            {recipients('cc')}
          </FieldRow>
        )}
        {showBcc && (
          <FieldRow label={t.compose.bcc} className="compose-row-bcc" extra={<span className="compose-row-extra">{contactsButton('bcc')}</span>}>
            {recipients('bcc')}
          </FieldRow>
        )}
        <FieldRow label={t.compose.subject}>
          <Form.Item name="subject" noStyle>
            <Input variant="borderless" className="compose-subject" />
          </Form.Item>
        </FieldRow>
      </div>
      <div className={`cv-card cv-paper${bodyFormat === 'html' ? ' is-source' : ''}`}>
        {editor}
        {signature}
        {attachments}
        {quote}
      </div>
    </div>
  );

  const foot =
    draft &&
    (editable ? (
      <div className="cv-foot">
        {sendGroup}
        {rejectButton}
        {attachButton}
        {followSelect}
        <span className="cv-foot-gap" />
        {trashButton}
      </div>
    ) : (
      <div className="cv-foot">
        {readonlyActions}
        <span className="cv-foot-gap" />
        {trashButton}
      </div>
    ));

  return (
    <Modal
      open={open}
      title={null}
      footer={null}
      closable={false}
      centered
      width={narrow ? '100%' : maximized ? 'calc(100vw - 48px)' : 880}
      // 点到弹窗外面不关闭，免得写到一半误触；Esc 和右上角关闭会先保存草稿
      mask={{ closable: false }}
      onCancel={close}
      afterOpenChange={(o) => !o && onClosed()}
      rootClassName={`compose-modal${editable ? ' is-editing' : ''}${maximized && !narrow ? ' is-max' : ''}${narrow ? ' is-narrow' : ''}`}
      styles={{ body: { padding: 0 } }}
    >
      {!draft ? (
        <Flex justify="center" style={{ padding: 48 }}>
          <Spin />
        </Flex>
      ) : (
        <div
          className="compose-surface"
          {...dropHandlers}
          onKeyDown={(e) => {
            // ⌘ / Ctrl + Enter 发送
            if (editable && e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy && uploading === 0) {
              e.preventDefault();
              void send();
            }
          }}
        >
          {/* 表单包住整个窗口（各版式的字段位置不同）；不能编辑时编辑区隐藏但不卸载，保存等逻辑照常 */}
          <Form<Values>
            className="compose-form"
            form={form}
            initialValues={{
              accountId: draft.accountId,
              to: draft.to.map(formatAddress),
              cc: draft.cc.map(formatAddress),
              bcc: draft.bcc.map(formatAddress),
              subject: draft.subject,
              body: draft.body,
              bodyHtml: draft.bodyHtml ?? textToHtml(draft.body),
              bodyFormat: draft.bodyFormat ?? 'rich',
              includeSignature: draft.includeSignature ?? true,
              includeQuote: draft.includeQuote,
              followUpDays: draft.followUpDays ?? null,
            }}
            onValuesChange={markChanged}
          >
            <Form.Item name="followUpDays" hidden>
              <InputNumber />
            </Form.Item>
            <Form.Item name="body" hidden>
              <Input />
            </Form.Item>
            <Form.Item name="bodyFormat" hidden>
              <Input />
            </Form.Item>
            {head}
            <div className="compose-alerts">{alerts}</div>
            {editable ? (
              editing
            ) : (
              <div className="cv-scroll cv-readonly">
                <DraftDetail draft={draft} scheduled={scheduled} />
              </div>
            )}
            {foot}
          </Form>
          {dragging && (
            <div className="compose-drop" aria-hidden="true">
              {dropInline ? <PictureOutlined /> : <CloudUploadOutlined />}
              {dropInline ? t.compose.dropToInline : t.compose.dropToAttach}
            </div>
          )}
        </div>
      )}
      <SignatureModal account={sigAccount} open={signatureOpen} onClose={() => setSignatureOpen(false)} />
      <ContactPicker
        open={picking !== null}
        title={t.compose.pickTitle(picking === 'cc' ? t.compose.cc : picking === 'bcc' ? t.compose.bcc : t.compose.to)}
        existing={picking ? ((form.getFieldValue(picking) as string[] | undefined) ?? []) : []}
        onClose={() => setPicking(null)}
        onPick={(values) => {
          if (!picking) return;
          const current = (form.getFieldValue(picking) as string[] | undefined) ?? [];
          form.setFieldValue(picking, [...current, ...values]);
          // setFieldValue 不触发 onValuesChange，手动记一次改动以便自动保存
          markChanged();
        }}
      />
      <Modal
        open={scheduleOpen}
        title={t.compose.schedule}
        okText={t.compose.schedule}
        okButtonProps={{ disabled: !customAt || customAt.isBefore(dayjs()), loading: busy === 'send' }}
        onOk={() => customAt && void send(customAt)}
        onCancel={() => setScheduleOpen(false)}
        destroyOnHidden
        width={360}
      >
        <DatePicker
          showTime={{ format: 'HH:mm', minuteStep: 5 }}
          format="YYYY-MM-DD HH:mm"
          value={customAt}
          onChange={setCustomAt}
          disabledDate={(d) => d.isBefore(dayjs(), 'day') || d.isAfter(dayjs().add(1, 'year'))}
          needConfirm={false}
          style={{ width: '100%' }}
        />
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
          {t.compose.scheduleHint}
        </Typography.Paragraph>
      </Modal>
    </Modal>
  );
}

/** 全局写信入口：任何地方调用 useCompose()({ mode: 'reply', sourceMessageId }) 打开写信抽屉 */
export function ComposeProvider({ children }: { children: ReactNode }) {
  const { message, notification } = App.useApp();
  const [current, setCurrent] = useState<{ id: number; fresh: boolean } | null>(null);
  // 刚发出的邮件，发送成功或失败时提醒
  const watching = useRef(new Set<number>());

  const openCompose = useCallback(
    async (opts: OpenOptions) => {
      if ('draftId' in opts) return setCurrent({ id: opts.draftId, fresh: false });
      try {
        const d = await api<Draft>('/api/v1/drafts', { method: 'POST', body: opts });
        setCurrent({ id: d.id, fresh: true });
      } catch (e) {
        message.error((e as Error).message);
      }
    },
    [message],
  );

  const onSent = useCallback(
    (d: Draft, scheduled = false) => {
      const key = `send-${d.id}`;
      if (scheduled && d.sendAt) {
        notification.success({
          key,
          title: t.compose.scheduledAt(formatSendAt(d.sendAt)),
          description: d.subject || t.compose.noSubject,
          actions: (
            <Button
              size="small"
              onClick={async () => {
                try {
                  await api(`/api/v1/drafts/${d.id}/cancel`, { method: 'POST' });
                  notification.destroy(key);
                  setCurrent({ id: d.id, fresh: false });
                } catch (e) {
                  message.error((e as Error).message);
                }
              }}
            >
              {t.compose.cancelSchedule}
            </Button>
          ),
        });
        watching.current.add(d.id);
        return;
      }
      const delay = d.sendDelaySec ?? 10;
      watching.current.add(d.id);
      notification.info({
        key,
        title: delay > 0 ? t.compose.sendIn(delay) : t.compose.sending,
        description: d.subject || t.compose.noSubject,
        duration: delay > 0 ? delay : 3,
        showProgress: delay > 0,
        actions:
          delay > 0 ? (
            <Button
              size="small"
              onClick={async () => {
                try {
                  await api(`/api/v1/drafts/${d.id}/cancel`, { method: 'POST' });
                  watching.current.delete(d.id);
                  notification.destroy(key);
                  setCurrent({ id: d.id, fresh: false });
                } catch (e) {
                  message.error((e as Error).message);
                }
              }}
            >
              {t.compose.undo}
            </Button>
          ) : undefined,
      });
    },
    [message, notification],
  );

  useEffect(() => {
    const onDraft = (e: Event) => {
      const { draftId, status } = (e as CustomEvent<{ draftId: number; status: string }>).detail;
      if (!watching.current.has(draftId)) return;
      if (status === 'sent') {
        watching.current.delete(draftId);
        message.success(t.compose.sent);
      } else if (status === 'failed') {
        watching.current.delete(draftId);
        notification.error({
          key: `send-${draftId}`,
          title: t.compose.sendFailed,
          description: t.compose.sendFailedDesc,
          duration: 0,
          actions: (
            <Button size="small" onClick={() => (notification.destroy(`send-${draftId}`), setCurrent({ id: draftId, fresh: false }))}>
              {t.compose.open}
            </Button>
          ),
        });
      }
    };
    window.addEventListener('damail:draft', onDraft);
    return () => window.removeEventListener('damail:draft', onDraft);
  }, [message, notification]);

  return (
    <ComposeContext.Provider value={openCompose}>
      {children}
      {current && (
        <ComposeDrawer
          key={current.id}
          draftId={current.id}
          fresh={current.fresh}
          onSent={onSent}
          onClosed={() => setCurrent((c) => (c?.id === current.id ? null : c))}
        />
      )}
    </ComposeContext.Provider>
  );
}
