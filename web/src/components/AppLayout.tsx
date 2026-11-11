import {
  ApiOutlined,
  BarChartOutlined,
  NotificationOutlined,
  BellOutlined,
  ContactsOutlined,
  ControlOutlined,
  ContainerOutlined,
  DeleteOutlined,
  FolderOutlined,
  GlobalOutlined,
  WarningOutlined,
  FireOutlined,
  HourglassOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SafetyOutlined,
  SecurityScanOutlined,
  ThunderboltOutlined,
  EditOutlined,
  FileSearchOutlined,
  CodeOutlined,
  FileTextOutlined,
  ProfileOutlined,
  HomeOutlined,
  InboxOutlined,
  LogoutOutlined,
  BgColorsOutlined,
  MailFilled,
  MailOutlined,
  ReadOutlined,
  SendOutlined,
  SettingOutlined,
  StarOutlined,
  UserOutlined,
  MenuFoldOutlined,
  MessageOutlined,
  MenuUnfoldOutlined,
  UnorderedListOutlined,
  AccountBookOutlined,
  CarOutlined,
  KeyOutlined,
  SolutionOutlined,
  TeamOutlined,
  TagsOutlined,
  TagOutlined,
  AuditOutlined,
  ClockCircleOutlined,
  TranslationOutlined,
  ExclamationCircleOutlined,
  LineChartOutlined,
  InfoCircleOutlined,
  HistoryOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Avatar, Badge, Button, ConfigProvider, Dropdown, Flex, Layout, Menu, Tooltip, theme, type MenuProps } from 'antd';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api, type AccountSummary, type CurrentUser, type Folder } from '../api';
import { t } from '../i18n';
import { useAccounts, useCategories, useDraftList, useFolders, useLabels, useLiveEvents, usePendingDrafts, useStats } from '../hooks/data';
import { useNewRelease } from '../hooks/updates';
import { DRAFT_TABS, defaultDraftTab } from '../pages/OutboxPage';
import { accountIconDomain, colorFor, folderLabel, sortFolders } from '../lib/format';
import { categoryOfQuery, categoryQuery, labelOfQuery, labelQuery } from '../lib/search';
import { CATEGORY_META } from './Insight';
import { labelHasName, labelName } from './Labels';
import { AccountSettingsModal } from './AccountSettings';
import { ASSISTANT_EXPANDED_KEY, Assistant, preloadAssistant, readAssistantPref, writeAssistantPref } from './Assistant';
import { ComposeProvider, useCompose } from './Compose';
import { NavContextMenu, type NavMenuTarget } from './NavContextMenu';
import { SenderAvatar } from './SenderAvatar';
import { CHANGELOG_PATH, useUpdateNotice } from './UpdateNotice';
import { APP_VERSION } from '../lib/about';
import { RADIUS, useComponentSize, useRadius, type SizeKey } from '../lib/theme';

const OPEN_KEYS = 'damail.sider.open';
const WIDTH_KEY = 'damail.sider.width';
const COLLAPSED_KEY = 'damail.sider.collapsed';
const RAIL_WIDTH = 68;

// 菜单面板的配色交给 styles.css 里的 --mh-* 变量（浅色 / 深色各一套），这里只定尺寸和颜色变量的对应关系
// 菜单项高度跟着「组件大小」走，圆角跟着「圆角」走（外观设置）
const NAV_ITEM_HEIGHT: Record<SizeKey, number> = { small: 28, middle: 32, large: 38 };
const navMenuTokens = (size: SizeKey, radius: number) => ({
  itemBg: 'transparent',
  subMenuItemBg: 'transparent',
  itemHeight: NAV_ITEM_HEIGHT[size],
  itemBorderRadius: Math.round(8 * radius),
  itemMarginInline: 8,
  itemMarginBlock: size === 'small' ? 2 : 4,
  iconSize: 15,
  iconMarginInlineEnd: 10,
  itemColor: 'var(--mh-nav-text)',
  itemHoverColor: 'var(--mh-nav-text-strong)',
  itemHoverBg: 'var(--mh-nav-hover)',
  itemActiveBg: 'var(--mh-nav-hover)',
  itemSelectedColor: 'var(--mh-nav-text-strong)',
  itemSelectedBg: 'var(--mh-nav-active)',
  groupTitleColor: 'var(--mh-nav-icon)',
});
const SIDER_MIN = 200;
const SIDER_DEFAULT = 220;
const SIDER_MAX = 380;

// 左侧图标栏的入口，按用途分组：处理邮件（概览、邮件、草稿、订阅）→ 回顾（报告、统计）→ 智能，设置固定在底部。
// 邮件、草稿、智能和设置有子菜单，显示在右边面板里；其他入口直接打开页面，面板隐藏
type Section = 'home' | 'mail' | 'drafts' | 'reports' | 'stats' | 'subscriptions' | 'contacts' | 'ai' | 'audit' | 'settings';
type PanelSection = 'mail' | 'drafts' | 'ai' | 'settings';
// 名字按当前语言取：t.layout.sections[key]
const SECTIONS: { key: Section; icon: ReactNode; home: string }[] = [
  { key: 'home', icon: <HomeOutlined />, home: '/' },
  { key: 'mail', icon: <InboxOutlined className="inbox-icon" />, home: '/mail' },
  { key: 'drafts', icon: <FileTextOutlined />, home: '/outbox' },
  { key: 'subscriptions', icon: <NotificationOutlined />, home: '/subscriptions' },
  { key: 'contacts', icon: <ContactsOutlined />, home: '/contacts' },
  { key: 'reports', icon: <ProfileOutlined />, home: '/reports' },
  { key: 'stats', icon: <BarChartOutlined />, home: '/dashboard' },
  { key: 'ai', icon: <RobotOutlined />, home: '/ai/models' },
  { key: 'audit', icon: <SecurityScanOutlined />, home: '/audit' },
  { key: 'settings', icon: <SettingOutlined />, home: '/settings/accounts' },
];
// 这些入口前面画一条分隔线，把分组隔开
const GROUP_START: Section[] = ['reports', 'ai', 'audit'];
const hasPanel = (x: Section): x is PanelSection => x === 'mail' || x === 'drafts' || x === 'ai' || x === 'settings';
const sectionOf = (path: string): Section => {
  if (path === '/') return 'home';
  if (path === '/outbox') return 'drafts';
  if (/^\/reports(\/|$)/.test(path)) return 'reports';
  if (path === '/dashboard') return 'stats';
  if (path === '/subscriptions') return 'subscriptions';
  if (path === '/contacts') return 'contacts';
  if (path.startsWith('/ai/')) return 'ai';
  if (path === '/audit') return 'audit';
  if (path.startsWith('/settings')) return 'settings';
  return 'mail';
};

/**
 * 菜单里的数字：总数浅灰；未读用浅蓝底小标签；需要处理的（待审批、发送失败）用浅橙 / 浅红底小标签。
 * 都是浅底彩色字，不用实色红徽标，整列不会太重。
 */
type CountLevel = 'total' | 'unread' | 'warning' | 'error';
function NavCount({ n, level = 'total' }: { n: number; level?: CountLevel }) {
  return <span className={`nav-count nav-count-${level}`}>{t.layout.shortCount(n)}</span>;
}
// 这些文件夹的未读没意义，垃圾邮件也不该用红点吸引注意，只显示总封数
const UNREADLESS = ['\\Sent', '\\Drafts', '\\Junk', '\\Trash'];

const FOLDER_ICONS: Record<string, ReactNode> = {
  '\\Inbox': <InboxOutlined className="inbox-icon" />,
  '\\Sent': <SendOutlined />,
  '\\Drafts': <FileTextOutlined />,
  '\\Archive': <ContainerOutlined />,
  '\\All': <MailOutlined />,
  '\\Flagged': <StarOutlined />,
  '\\Junk': <WarningOutlined />,
  '\\Trash': <DeleteOutlined />,
};

const DRAFT_ICONS: Record<(typeof DRAFT_TABS)[number]['key'], ReactNode> = {
  pending: <AuditOutlined />,
  drafts: <FileTextOutlined />,
  outbox: <ClockCircleOutlined />,
  sent: <SendOutlined />,
  failed: <ExclamationCircleOutlined />,
};

// 侧栏「分类」里列出的 AI 分类；重要、垃圾已有对应入口，不重复
const CATEGORY_ICONS: Array<[string, ReactNode]> = [
  ['finance', <AccountBookOutlined />],
  ['shipping', <CarOutlined />],
  ['verification', <KeyOutlined />],
  ['work', <SolutionOutlined />],
  ['personal', <UserOutlined />],
  ['social', <TeamOutlined />],
  ['notification', <BellOutlined />],
  ['marketing', <TagsOutlined />],
];

const clampWidth = (w: number) => Math.round(Math.min(SIDER_MAX, Math.max(SIDER_MIN, w)));

function loadWidth() {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return v ? clampWidth(v) : SIDER_DEFAULT;
  } catch {
    return SIDER_DEFAULT;
  }
}

function saveWidth(w: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    // 存不下只影响下次打开时的宽度
  }
}

function loadCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

// 正常时不显示状态点，免得每个邮箱都挂一个绿点
const STATUS_TOKEN: Record<Exclude<AccountSummary['status'], 'idle'>, 'colorPrimary' | 'colorWarning' | 'colorError' | 'colorTextQuaternary'> = {
  syncing: 'colorPrimary',
  connecting: 'colorWarning',
  error: 'colorError',
  disabled: 'colorTextQuaternary',
};

export function AppLayout({ username }: { username: string }) {
  return (
    <ComposeProvider>
      <Shell username={username} />
    </ComposeProvider>
  );
}

function Shell({ username }: { username: string }) {
  useLiveEvents();
  const compose = useCompose();
  const pending = usePendingDrafts();
  const pendingCount = pending.data?.length ?? 0;
  // GitHub 上有更新的正式版本：设置图标、「更新日志」和头像菜单的版本号上挂红点
  const newRelease = useNewRelease();
  const newDot = newRelease ? <span className="nav-dot" title={t.about.newVersionBadge} /> : null;
  // 草稿面板里各分类的数量；已发送会越来越多，不显示
  const draftCount = {
    drafts: useDraftList('draft,rejected').data?.length ?? 0,
    outbox: useDraftList('queued,sending').data?.length ?? 0,
    failed: useDraftList('failed').data?.length ?? 0,
  };
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  // 手动收起/展开记在本地；窗口变窄时自动收起的不记
  const toggleCollapsed = (next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // 存不下只影响下次打开时的状态
    }
  };
  // 可以拖面板右边缘拉宽，好看全邮箱地址
  const [siderWidth, setSiderWidth] = useState(loadWidth);
  const [resizing, setResizing] = useState(false);
  const resize = (w: number) => {
    const next = clampWidth(w);
    setSiderWidth(next);
    saveWidth(next);
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  // 助手默认是右下角的浮动小窗，展开后占满内容区（菜单面板也让出来）
  const [assistantExpanded, setAssistantExpanded] = useState(() => readAssistantPref(ASSISTANT_EXPANDED_KEY) === '1');
  const expandAssistant = (v: boolean) => {
    writeAssistantPref(ASSISTANT_EXPANDED_KEY, v ? '1' : null);
    setAssistantExpanded(v);
  };
  const assistantFull = assistantOpen && assistantExpanded;
  // 展开时跳到别的页面（点引用的邮件、点图标栏）就收成小窗，让出内容区
  const navKey = location.pathname + location.search;
  const lastNav = useRef(navKey);
  const fullRef = useRef(assistantFull);
  fullRef.current = assistantFull;
  useEffect(() => {
    if (lastNav.current === navKey) return;
    lastNav.current = navKey;
    if (fullRef.current) expandAssistant(false);
  }, [navKey]);
  const accounts = useAccounts();
  const folders = useFolders();
  const stats = useStats();
  const labels = useLabels();
  // 分类名称以服务端的为准（拿到后 CATEGORY_META 改用它）
  useCategories();

  // 邮箱默认收起，展开状态记在本地
  const [openKeys, setOpenKeys] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(OPEN_KEYS) ?? '[]') as unknown;
      return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
    } catch {
      return [];
    }
  });
  const onOpenChange = (keys: string[]) => {
    setOpenKeys(keys);
    try {
      localStorage.setItem(OPEN_KEYS, JSON.stringify(keys));
    } catch {
      // 存不下只影响下次打开时的展开状态
    }
  };

  const totalUnread = (accounts.data ?? []).reduce((s, a) => s + a.inboxUnread, 0);
  const importantUnread = stats.data?.importantUnread ?? 0;
  const followUpsDue = stats.data?.followUpsDue ?? 0;
  const st = stats.data;
  // 只同步了默认的系统文件夹时，「全部邮件」和收件箱、已发送重复（不含草稿、垃圾邮件、已删除），不显示
  const hasExtraFolders = (folders.data ?? []).some(
    (f) => f.syncEnabled && f.path.toUpperCase() !== 'INBOX' && !['\\Inbox', '\\Sent', '\\Drafts', '\\Trash', '\\Junk'].includes(f.specialUse ?? ''),
  );

  const selectedKey = useMemo(() => {
    if (location.pathname.startsWith('/settings') || location.pathname.startsWith('/ai/')) return location.pathname;
    if (location.pathname === '/outbox') return `/outbox?tab=${params.get('tab') ?? defaultDraftTab(pendingCount)}`;
    if (params.get('folder')) return `folder:${params.get('folder')}`;
    const category = !params.get('account') && categoryOfQuery(params.get('q'));
    if (category) return `cat:${category}`;
    const labelName = !params.get('account') && labelOfQuery(params.get('q'));
    const label = labelName && labels.data?.find((l) => labelHasName(l, labelName));
    if (label) return `lbl:${label.id}`;
    if (params.get('account')) return `account:${params.get('account')}`;
    return `view:${params.get('view') ?? 'inbox'}`;
  }, [location.pathname, params, pendingCount, labels.data]);

  const section = sectionOf(location.pathname);
  // 切回某个分区时回到上次在这个分区看的页面
  const lastPath = useRef<Record<Section, string>>(Object.fromEntries(SECTIONS.map((x) => [x.key, x.home])) as Record<Section, string>);
  useEffect(() => {
    lastPath.current[section] = location.pathname + location.search;
  }, [section, location.pathname, location.search]);
  const openSection = (next: Section) => {
    if (collapsed && hasPanel(next)) toggleCollapsed(false);
    if (next !== section) navigate(lastPath.current[next]);
  };

  const items: Record<PanelSection, MenuProps['items']> = useMemo(() => {
    // 未读数前面挂个红点，和总封数区分开
    const unreadMark = (n: number) => <NavCount n={n} level="unread" />;
    // 有未读显示未读（深色加粗）；没有未读或者未读没意义（已发送、草稿、垃圾邮件、已删除）的显示总封数，浅灰
    const folderCount = (unread: number, total: number, unreadless = false) =>
      !unreadless && unread > 0 ? (
        <Tooltip title={t.layout.unreadCount(unread)} placement="right">
          {unreadMark(unread)}
        </Tooltip>
      ) : total > 0 ? (
        <Tooltip title={t.layout.totalCount(total)} placement="right">
          <NavCount n={total} />
        </Tooltip>
      ) : null;
    const isInboxFolder = (f: Folder) => f.specialUse === '\\Inbox' || f.path.toUpperCase() === 'INBOX';
    const accountItems = (accounts.data ?? []).map((a) => {
      const syncedFolders = sortFolders((folders.data ?? []).filter((f) => f.accountId === a.id && f.syncEnabled));
      const inboxTotal = syncedFolders.filter(isInboxFolder).reduce((n, f) => n + f.localCount, 0);
      return {
        key: `acc:${a.id}`,
        icon: (
          <span className="anticon" style={{ lineHeight: 0 }}>
            <Badge dot={a.status !== 'idle'} color={a.status === 'idle' ? undefined : token[STATUS_TOKEN[a.status]]} offset={[-2, 18]}>
              <SenderAvatar
                address={a.email}
                name={a.name}
                size={20}
                iconDomain={accountIconDomain(a)}
                color={a.color ?? colorFor(a.id)}
                text={a.name.trim().slice(0, 1).toUpperCase()}
              />
            </Badge>
          </span>
        ),
        label: (
          <Tooltip title={`${a.email} · ${t.layout.accountStatus[a.status]}${a.lastError ? `：${a.lastError}` : ''}`} placement="right">
            <Flex justify="space-between" align="center" gap={8}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
              {!openKeys.includes(`acc:${a.id}`) && a.inboxUnread > 0 && <span style={{ marginInlineEnd: 18 }}>{unreadMark(a.inboxUnread)}</span>}
            </Flex>
          </Tooltip>
        ),
        children: [
          {
            key: `account:${a.id}`,
            icon: <InboxOutlined className="inbox-icon" />,
            label: (
              <Flex justify="space-between" align="center" gap={8}>
                <span>{t.layout.mail.inbox}</span>
                {folderCount(a.inboxUnread, inboxTotal)}
              </Flex>
            ),
          },
          ...syncedFolders
            .filter((f) => !isInboxFolder(f))
            .map((f) => ({
              key: `folder:${f.id}`,
              icon: (f.specialUse && FOLDER_ICONS[f.specialUse]) || <FolderOutlined />,
              label: (
                <Flex justify="space-between" align="center" gap={8}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{folderLabel(f)}</span>
                  {folderCount(f.unreadCount, f.localCount, UNREADLESS.includes(f.specialUse ?? ''))}
                </Flex>
              ),
            })),
        ],
      };
    });

    // 分类收起时在标题上显示未读合计，和邮箱一样
    const catsOpen = openKeys.includes('cats') || selectedKey.startsWith('cat:');
    const catUnread = CATEGORY_ICONS.reduce((sum, [c]) => sum + (st?.categories[c]?.unread ?? 0), 0);
    // 标签：只列出「侧栏显示」的，和分类一样收起时标题上显示未读合计
    const pinnedLabels = (labels.data ?? []).filter((l) => l.pinned);
    const labelCount = (id: number) => st?.labels?.[id] ?? labels.data?.find((l) => l.id === id) ?? { total: 0, unread: 0 };
    const lblsOpen = openKeys.includes('lbls') || selectedKey.startsWith('lbl:');
    const lblUnread = pinnedLabels.reduce((sum, l) => sum + labelCount(l.id).unread, 0);
    const count = (n: number, level: CountLevel = 'total') => (n > 0 ? <NavCount n={n} level={level} /> : null);
    const group = (label: string, children: NonNullable<MenuProps['items']>) => [{ type: 'group' as const, label, children }];
    const row = (text: string, extra: ReactNode) => (
      <Flex justify="space-between" align="center" gap={8}>
        <span>{text}</span>
        {extra}
      </Flex>
    );

    return {
      mail: [
        { key: 'view:inbox', icon: <InboxOutlined className="inbox-icon" />, label: row(t.layout.mail.inbox, count(totalUnread, 'unread')) },
        { key: 'view:important', icon: <FireOutlined />, label: row(t.layout.mail.important, count(importantUnread, 'unread')) },
        {
          key: 'view:waiting',
          icon: <HourglassOutlined />,
          label: (
            <Tooltip title={followUpsDue ? t.layout.mail.followUpsDue(followUpsDue) : t.layout.mail.waitingHint} placement="right">
              {row(t.layout.mail.waiting, followUpsDue ? count(followUpsDue, 'unread') : count(st?.waitingTotal ?? 0))}
            </Tooltip>
          ),
        },
        { key: 'view:unread', icon: <ReadOutlined />, label: row(t.layout.mail.unread, count(st?.unreadTotal ?? 0)) },
        { key: 'view:starred', icon: <StarOutlined />, label: row(t.layout.mail.starred, count(st?.starredTotal ?? 0)) },
        { key: 'view:sent', icon: <SendOutlined />, label: row(t.layout.mail.sent, count(st?.sentTotal ?? 0)) },
        ...(hasExtraFolders ? [{ key: 'view:all', icon: <MailOutlined />, label: row(t.layout.mail.all, count(st?.allTotal ?? 0)) }] : []),
        // AI 分类，默认收起，展开状态和邮箱一起记在本地
        {
          key: 'cats',
          icon: <TagsOutlined />,
          label: (
            <Flex justify="space-between" align="center" gap={8}>
              <span>{t.layout.mail.categories}</span>
              {!catsOpen && catUnread > 0 && <span style={{ marginInlineEnd: 18 }}>{unreadMark(catUnread)}</span>}
            </Flex>
          ),
          children: CATEGORY_ICONS.map(([c, icon]) => ({
            key: `cat:${c}`,
            icon,
            label: (
              <Flex justify="space-between" align="center" gap={8}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{CATEGORY_META[c]?.label ?? c}</span>
                {folderCount(st?.categories[c]?.unread ?? 0, st?.categories[c]?.total ?? 0)}
              </Flex>
            ),
          })),
        },
        {
          key: 'lbls',
          icon: <TagOutlined />,
          label: (
            <Flex justify="space-between" align="center" gap={8}>
              <span>{t.layout.mail.labels}</span>
              {!lblsOpen && lblUnread > 0 && <span style={{ marginInlineEnd: 18 }}>{unreadMark(lblUnread)}</span>}
            </Flex>
          ),
          children: [
            ...pinnedLabels.map((l) => ({
              key: `lbl:${l.id}`,
              icon: (
                <span
                  className="nav-label-dot"
                  style={{ '--dot': (token as unknown as Record<string, string>)[l.color] ?? token.colorPrimary } as CSSProperties}
                />
              ),
              label: (
                <Flex justify="space-between" align="center" gap={8}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{labelName(l)}</span>
                  {folderCount(labelCount(l.id).unread, labelCount(l.id).total)}
                </Flex>
              ),
            })),
          ],
        },
        ...(accountItems.length ? group(t.layout.mail.accounts, accountItems) : []),
      ],
      drafts: DRAFT_TABS.map((tab) => ({
        key: `/outbox?tab=${tab.key}`,
        icon: DRAFT_ICONS[tab.key],
        label: row(
          t.outbox.tabs[tab.key],
          tab.key === 'pending'
            ? count(pendingCount, 'warning')
            : tab.key === 'failed'
              ? count(draftCount.failed, 'error')
              : tab.key === 'sent'
                ? null
                : count(draftCount[tab.key]),
        ),
      })),
      // 按依赖排：先有模型，才能分析邮件；规则用到分析结果和通知渠道
      ai: [
        ...group(t.layout.ai.analysis, [
          { key: '/ai/models', icon: <RobotOutlined />, label: t.layout.ai.models },
          { key: '/ai/analysis', icon: <FileSearchOutlined />, label: t.layout.ai.mailAnalysis },
          { key: '/ai/labels', icon: <TagOutlined />, label: t.layout.ai.labels },
          { key: '/ai/prompts', icon: <CodeOutlined />, label: t.layout.ai.prompts },
        ]),
        ...group(t.layout.ai.automation, [
          { key: '/ai/channels', icon: <BellOutlined />, label: t.layout.ai.channels },
          { key: '/ai/rules', icon: <ThunderboltOutlined />, label: t.layout.ai.rules },
        ]),
        ...group(t.layout.ai.usage, [
          { key: '/ai/requests', icon: <UnorderedListOutlined />, label: t.layout.ai.requests },
          { key: '/ai/stats', icon: <LineChartOutlined />, label: t.layout.ai.stats },
        ]),
      ],
      settings: [
        ...group(t.layout.settings.basic, [
          { key: '/settings/appearance', icon: <BgColorsOutlined />, label: t.layout.settings.appearance },
          { key: '/settings/language', icon: <TranslationOutlined />, label: t.layout.settings.language },
        ]),
        ...group(t.layout.settings.mailAccess, [
          { key: '/settings/accounts', icon: <MailOutlined />, label: t.layout.settings.accounts },
          { key: '/settings/oauth', icon: <SafetyCertificateOutlined />, label: t.layout.settings.oauthApps },
          { key: '/settings/proxies', icon: <GlobalOutlined />, label: t.layout.settings.proxies },
        ]),
        ...group(t.layout.settings.openApi, [
          { key: '/settings/mcp', icon: <ApiOutlined />, label: t.layout.settings.mcp },
          { key: '/settings/api', icon: <KeyOutlined />, label: t.layout.settings.apiKey },
          { key: '/settings/mcp-oauth', icon: <ControlOutlined />, label: t.layout.settings.oauthSettings },
          { key: '/settings/mcp-authorizations', icon: <SafetyOutlined />, label: t.layout.settings.oauthGrants },
        ]),
        ...group(t.layout.settings.aboutGroup, [
          { key: '/settings/about', icon: <InfoCircleOutlined />, label: t.layout.settings.about },
          {
            key: '/settings/changelog',
            icon: <HistoryOutlined />,
            label: (
              <>
                {t.layout.settings.changelog}
                {newDot}
              </>
            ),
          },
        ]),
      ],
    };
  }, [
    accounts.data,
    folders.data,
    st,
    totalUnread,
    importantUnread,
    followUpsDue,
    hasExtraFolders,
    labels.data,
    openKeys,
    selectedKey,
    token,
    pendingCount,
    draftCount.drafts,
    draftCount.outbox,
    draftCount.failed,
    newDot,
  ]);

  // 侧栏菜单项左键点击去的地址
  const urlOf = (key: string): string | null => {
    if (key.startsWith('/')) return key;
    const [kind, value] = key.split(':');
    const next = new URLSearchParams();
    if (kind === 'view' && value !== 'inbox') next.set('view', value!);
    if (kind === 'account' || kind === 'acc') next.set('account', value!);
    if (kind === 'folder') next.set('folder', value!);
    if (kind === 'cat') {
      next.set('view', 'all');
      next.set('q', categoryQuery(value!));
    }
    if (kind === 'lbl') {
      const label = labels.data?.find((l) => String(l.id) === value);
      if (!label) return null;
      next.set('view', 'all');
      next.set('q', labelQuery(labelName(label)));
    }
    return `/mail${next.size ? `?${next}` : ''}`;
  };
  // 路由切换在 transition 里渲染，选中高亮要等新页面渲染完才出现，看起来卡。
  // 点击时先单独把高亮切过去（普通更新，立即提交），页面随后渲染
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  useEffect(() => setPendingKey(null), [location.key]);
  const onClick: MenuProps['onClick'] = ({ key }) => {
    const url = urlOf(key);
    if (!url) return;
    if (key !== selectedKey) setPendingKey(key);
    navigate(url);
  };

  // 侧栏右键菜单：按菜单项算出名称、筛选条件、未读数
  const [navMenu, setNavMenu] = useState<NavMenuTarget | null>(null);
  const navMenuInfo = (key: string): Omit<NavMenuTarget, 'x' | 'y'> | null => {
    const [kind, value] = key.split(':');
    const url = urlOf(key);
    if (!url || !value) return null;
    const st = stats.data;
    if (kind === 'view') {
      if (value === 'sent' || value === 'waiting') return null;
      const unread: Record<string, number | undefined> = { inbox: totalUnread, important: importantUnread, unread: st?.unreadTotal };
      const name = t.layout.mail[value as 'inbox' | 'important' | 'unread' | 'starred' | 'all'];
      return { name, url, unreadFilter: value !== 'unread', markRead: { body: { view: value }, unread: unread[value] } };
    }
    if (kind === 'cat')
      return {
        name: CATEGORY_META[value]?.label ?? value,
        url,
        unreadFilter: true,
        markRead: { body: { view: 'all', q: categoryQuery(value) }, unread: st?.categories[value]?.unread ?? 0 },
        category: true,
      };
    if (kind === 'lbl') {
      const label = labels.data?.find((l) => String(l.id) === value);
      if (!label) return null;
      const unread = st?.labels?.[label.id]?.unread ?? label.unread;
      return { name: labelName(label), url, unreadFilter: true, markRead: { body: { view: 'all', q: labelQuery(labelName(label)) }, unread }, label };
    }
    if (kind === 'acc' || kind === 'account') {
      const a = accounts.data?.find((x) => String(x.id) === value);
      if (!a) return null;
      return {
        name: kind === 'acc' ? a.name : `${a.name} · ${t.layout.mail.inbox}`,
        url,
        unreadFilter: true,
        markRead: { body: { account: a.id }, unread: a.inboxUnread },
        accountId: a.id,
      };
    }
    if (kind === 'folder') {
      const f = folders.data?.find((x) => String(x.id) === value);
      if (!f) return null;
      const unreadless = UNREADLESS.includes(f.specialUse ?? '');
      return {
        name: folderLabel(f),
        url,
        unreadFilter: !unreadless,
        markRead: unreadless ? undefined : { body: { folder: f.id }, unread: f.unreadCount },
        accountId: f.accountId,
      };
    }
    return null;
  };
  const onNavContextMenu = (e: ReactMouseEvent) => {
    // 按住 Shift 保留浏览器自己的菜单
    if (e.shiftKey) return;
    const el = (e.target as HTMLElement).closest('[data-menu-id]');
    const key = el?.getAttribute('data-menu-id')?.replace(/^app-nav-/, '');
    const info = key ? navMenuInfo(key) : null;
    if (!info) return;
    e.preventDefault();
    setNavMenu({ x: e.clientX, y: e.clientY, ...info });
  };
  const closeNavMenu = useCallback(() => setNavMenu(null), []);

  const componentSize = useComponentSize();
  const radiusScale = RADIUS[useRadius()].scale;
  const { message } = AntApp.useApp();
  useUpdateNotice();
  // 先把登录状态改成未登录，界面立即切到登录页；再清掉其余缓存的数据。
  // 不能直接 qc.clear()：登录状态的查询也会被删掉，页面收不到变化，看起来点了没反应
  const logout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      message.error((e as Error).message);
      return;
    }
    qc.setQueryData<{ needsSetup: boolean; user: CurrentUser | null }>(['auth'], { needsSetup: false, user: null });
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
  };

  const panelHidden = collapsed || !hasPanel(section) || assistantFull;
  // 在别的分区或者面板收起时看不到未读数，在「邮件」图标上挂个红点
  const mailDot = (panelHidden || section !== 'mail') && totalUnread > 0;
  const startCompose = () => compose({ mode: 'new', accountId: Number(params.get('account')) || accounts.data?.[0]?.id });
  const current = SECTIONS.find((x) => x.key === section)!;

  const railItem = (x: (typeof SECTIONS)[number]) => (
    <button
      key={x.key}
      type="button"
      className={`rail-item${x.key === section && !assistantFull ? ' active' : ''}`}
      title={t.layout.sections[x.key]}
      aria-current={x.key === section ? 'page' : undefined}
      onClick={() => {
        if (assistantFull) expandAssistant(false);
        openSection(x.key);
      }}
    >
      <Badge
        dot={(x.key === 'mail' && mailDot) || (x.key === 'settings' && Boolean(newRelease))}
        // 只有草稿显示数字；其他图标传 count=0 时 antd 不显示红点（dot && !isZero），所以不传
        count={x.key === 'drafts' ? pendingCount : undefined}
        color={x.key === 'drafts' && pendingCount ? token.colorWarning : undefined}
        size="small"
        title={x.key === 'drafts' && pendingCount ? t.layout.pendingApproval(pendingCount) : undefined}
        offset={x.key === 'drafts' ? [4, 0] : [-1, 2]}
      >
        <span className="rail-icon">{x.icon}</span>
      </Badge>
      <span className="rail-label">{(x.key === 'subscriptions' || x.key === 'contacts' ? t.layout.railShort[x.key] : null) ?? t.layout.sections[x.key]}</span>
    </button>
  );

  return (
    <Layout hasSider className="app-shell" style={{ height: '100%' }}>
      <Flex
        vertical
        align="center"
        component="nav"
        aria-label={t.layout.mainNav}
        className="app-rail"
        style={{ width: RAIL_WIDTH, flex: 'none', height: '100%' }}
      >
        <Flex align="center" justify="center" style={{ height: 56, flex: 'none' }}>
          <Link to="/" className="app-logo" aria-label={t.layout.backHome} title={t.layout.sections.home}>
            <MailFilled />
          </Link>
        </Flex>
        {/* 面板收起时写邮件按钮挪到图标栏 */}
        {collapsed && section === 'mail' && (
          <Tooltip title={t.layout.compose} placement="right">
            <Button
              type="primary"
              aria-label={t.layout.compose}
              icon={<EditOutlined />}
              disabled={!accounts.data?.length}
              style={{ width: 40, height: 40, marginBottom: 8, flex: 'none' }}
              onClick={startCompose}
            />
          </Tooltip>
        )}
        {/* 入口多，窗口矮时这一段可以滚动，设置和头像始终在底部 */}
        <Flex vertical align="center" gap={4} className="rail-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%' }}>
          {SECTIONS.filter((x) => x.key !== 'settings').map((x) => (
            <Fragment key={x.key}>
              {GROUP_START.includes(x.key) && <div className="rail-sep" role="separator" />}
              {railItem(x)}
            </Fragment>
          ))}
        </Flex>
        {collapsed && hasPanel(section) && (
          <Tooltip title={t.layout.expandMenu} placement="right">
            <Button
              type="text"
              aria-label={t.layout.expandMenu}
              icon={<MenuUnfoldOutlined style={{ fontSize: 16 }} />}
              onClick={() => toggleCollapsed(false)}
            />
          </Tooltip>
        )}
        {/* AI 助手入口放在图标栏，不再浮在内容上挡住分页和按钮 */}
        <Flex vertical align="center" gap={4} style={{ paddingTop: 4, flex: 'none' }}>
          <button
            type="button"
            className={`rail-item${assistantOpen ? ' active' : ''}`}
            title={t.layout.assistantTitle}
            aria-pressed={assistantOpen}
            onClick={() => setAssistantOpen(!assistantOpen)}
            onPointerEnter={preloadAssistant}
          >
            <span className="rail-icon">
              <MessageOutlined />
            </span>
            <span className="rail-label">{t.layout.railShort.assistant ?? t.layout.assistant}</span>
          </button>
          {railItem(SECTIONS.find((x) => x.key === 'settings')!)}
        </Flex>
        <Dropdown
          trigger={['click']}
          placement="topLeft"
          menu={{
            items: [
              { type: 'group', label: t.layout.admin(username) },
              { key: 'settings', icon: <UserOutlined />, label: t.layout.accountSettings },
              { type: 'divider' },
              { key: 'logout', icon: <LogoutOutlined />, label: t.layout.logout, danger: true },
              { type: 'divider' },
              // 版本号和更新日志入口，点了去「关于」页的更新日志
              {
                key: 'changelog',
                icon: <InfoCircleOutlined />,
                label: (
                  <>
                    <span className="menu-version">{t.layout.versionItem(APP_VERSION)}</span>
                    {newDot}
                  </>
                ),
              },
            ],
            onClick: ({ key }) => {
              if (key === 'logout') void logout();
              else if (key === 'changelog') navigate(CHANGELOG_PATH);
              else setSettingsOpen(true);
            },
          }}
        >
          <Button type="text" aria-label={t.layout.accountMenu(username)} style={{ width: 44, height: 44, padding: 0, margin: '8px 0 12px', flex: 'none' }}>
            <Avatar size={30} style={{ background: colorFor(username) }}>
              {username.slice(0, 1).toUpperCase()}
            </Avatar>
          </Button>
        </Dropdown>
      </Flex>
      <Layout.Sider
        width={siderWidth}
        collapsedWidth={0}
        collapsible
        trigger={null}
        collapsed={panelHidden}
        onCollapse={(next, type) => (type === 'responsive' ? setCollapsed(next) : toggleCollapsed(next))}
        breakpoint="lg"
        theme="light"
        className="app-sider"
        style={{ overflow: 'hidden', transition: resizing ? 'none' : undefined }}
      >
        {/* 固定内容宽度，收起动画时菜单不被挤压换行；按分区重建，切换分区或面板出现时菜单淡入滑入 */}
        <Flex key={section} vertical className="app-sider-inner" style={{ height: '100%', width: siderWidth }}>
          <Flex align="center" style={{ height: 56, padding: '0 10px 0 18px', flex: 'none' }}>
            <span className="app-nav-title" style={{ flex: 1 }}>
              {t.layout.sections[current.key]}
            </span>
            <Tooltip title={t.layout.collapseMenu}>
              <Button
                type="text"
                size="small"
                aria-label={t.layout.collapseMenu}
                icon={<MenuFoldOutlined />}
                onClick={() => toggleCollapsed(true)}
                style={{ color: token.colorTextTertiary }}
              />
            </Tooltip>
          </Flex>
          {section === 'mail' && (
            <Button
              type="primary"
              icon={<EditOutlined />}
              disabled={!accounts.data?.length}
              onClick={startCompose}
              className="compose-button"
              style={{ margin: '0 8px 8px', flex: 'none' }}
            >
              {t.layout.compose}
            </Button>
          )}
          <ConfigProvider theme={{ components: { Menu: navMenuTokens(componentSize, radiusScale) } }}>
            <Menu
              // 固定 id：菜单项的 data-menu-id 是「app-nav-<key>」，右键菜单靠它找到点的是哪一项
              id="app-nav"
              className="app-nav"
              onContextMenu={onNavContextMenu}
              mode="inline"
              items={hasPanel(section) ? items[section] : []}
              selectedKeys={[pendingKey ?? selectedKey]}
              // 选中某个分类 / 标签时自动展开对应的分组
              openKeys={[
                ...openKeys,
                ...(selectedKey.startsWith('cat:') && !openKeys.includes('cats') ? ['cats'] : []),
                ...(selectedKey.startsWith('lbl:') && !openKeys.includes('lbls') ? ['lbls'] : []),
              ]}
              onOpenChange={onOpenChange}
              onClick={onClick}
              style={{ borderInlineEnd: 0, flex: 1, minHeight: 0, overflow: 'auto' }}
            />
          </ConfigProvider>
        </Flex>
        {!panelHidden && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t.layout.resizeMenu}
            aria-valuemin={SIDER_MIN}
            aria-valuemax={SIDER_MAX}
            aria-valuenow={siderWidth}
            tabIndex={0}
            title={t.layout.resizeHint}
            onPointerDown={(e) => {
              e.preventDefault();
              const left = e.currentTarget.parentElement!.getBoundingClientRect().left;
              e.currentTarget.setPointerCapture(e.pointerId);
              setResizing(true);
              const el = e.currentTarget;
              const move = (ev: PointerEvent) => setSiderWidth(clampWidth(ev.clientX - left));
              const up = (ev: PointerEvent) => {
                el.removeEventListener('pointermove', move);
                el.removeEventListener('pointerup', up);
                el.removeEventListener('pointercancel', up);
                setResizing(false);
                resize(ev.clientX - left);
              };
              el.addEventListener('pointermove', move);
              el.addEventListener('pointerup', up);
              el.addEventListener('pointercancel', up);
            }}
            onDoubleClick={() => resize(SIDER_DEFAULT)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                resize(siderWidth + (e.key === 'ArrowRight' ? 16 : -16));
              }
            }}
            // 悬停交给 CSS :hover；不用 pointerenter/leave 记状态，否则鼠标停在拖动条上时面板被隐藏（切到没有子菜单的页面），
            // 收不到 pointerleave，面板再出现时细线会一直亮着
            className={`sider-resize${resizing ? ' active' : ''}`}
          />
        )}
      </Layout.Sider>
      <Layout.Content className="app-canvas" style={{ minWidth: 0, display: assistantFull ? 'none' : undefined }}>
        {/* 按分区重建：切换分区时新页面淡入、轻轻上移，避免整块内容瞬间替换显得闪 */}
        <div key={section} className="app-page">
          <Outlet />
        </div>
      </Layout.Content>
      <Assistant open={assistantOpen} expanded={assistantExpanded} username={username} onClose={() => setAssistantOpen(false)} onExpand={expandAssistant} />
      <NavContextMenu target={navMenu} onClose={closeNavMenu} />
      <AccountSettingsModal open={settingsOpen} username={username} onClose={() => setSettingsOpen(false)} />
    </Layout>
  );
}
