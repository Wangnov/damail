import { Button, Empty, Flex, Grid, Splitter, Typography, theme } from 'antd';
import { useNavigate, useSearchParams } from 'react-router';
import { AiSearchResults } from '../components/AiSearchResults';
import { SearchBox, SearchConditions, searchLang } from '../components/SearchBox';
import { ThreadList } from '../components/ThreadList';
import { ThreadView } from '../components/ThreadView';
import { useAccounts, useFolders, useLabels } from '../hooks/data';
import { labelHasName, labelName as nameOf } from '../components/Labels';
import { folderLabel } from '../lib/format';
import { categoryOfQuery, labelOfQuery, localizeQuery, normalizeQuery } from '../lib/search';
import { CATEGORY_META } from '../components/Insight';
import { t, useLocale } from '../i18n';

export function MailPage() {
  const { token } = theme.useToken();
  // 窄屏（< 992px）改为单栏：列表和详情二选一
  const narrow = !Grid.useBreakpoint().lg;
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const accounts = useAccounts();
  const folders = useFolders();
  const labels = useLabels();
  const q = params.get('q') ?? '';
  // AI 搜索：自然语言描述，由模型理解后筛选
  const aiMode = params.get('ai') === '1' && Boolean(q);
  const lang = searchLang(useLocale());

  const view = params.get('view') ?? 'inbox';
  const accountId = params.get('account');
  const folderId = params.get('folder');
  const selected = params.get('thread');
  const unreadOnly = params.get('filter') === 'unread';

  const folder = folderId ? folders.data?.find((x) => String(x.id) === folderId) : undefined;
  const inTrash = folder?.specialUse === '\\Trash';

  let title = t.mail.views[view] ?? t.mail.mail;
  if (accountId) title = accounts.data?.find((a) => String(a.id) === accountId)?.name ?? t.mail.account;
  if (folder) {
    const acc = accounts.data?.find((a) => a.id === folder.accountId);
    title = `${acc?.name ?? ''} · ${folderLabel(folder)}`;
  }
  // 侧栏「分类」点进来的只有一个分类条件，标题直接写分类名
  const category = !aiMode && categoryOfQuery(q);
  const labelName = !aiMode && labelOfQuery(q);
  if (category) title = t.mail.categoryTitle(CATEGORY_META[category]?.label ?? category);
  else if (labelName) {
    // 链接里可能是另一种语言的名称，标题按当前语言显示
    const label = labels.data?.find((l) => labelHasName(l, labelName));
    title = t.mail.labelTitle(label ? nameOf(label) : labelName);
  } else if (q) title = aiMode ? t.mail.aiSearchTitle(q) : t.mail.searchTitle(localizeQuery(q, lang));

  // 正在搜索时标题是「搜索：…」，窄屏占位符不再拿它拼「搜索搜索：…」
  const searching = Boolean(q) && !category && !labelName;

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  const onSearch = (raw: string, ai = aiMode) => {
    // 普通搜索把中文写法换成英文语法；AI 搜索是自然语言，原样交给模型
    const value = ai ? raw.trim() : normalizeQuery(raw);
    const next = new URLSearchParams(params);
    next.delete('thread');
    if (value) next.set('q', value);
    else next.delete('q');
    if (ai && value) next.set('ai', '1');
    else next.delete('ai');
    setParams(next);
  };

  const threadList = aiMode ? (
    <AiSearchResults q={q} selected={selected} onSelect={(id) => setParam('thread', id)} onPlain={() => onSearch(q, false)} />
  ) : (
    <ThreadList
      view={view}
      accountId={accountId}
      folderId={folderId}
      inTrash={inTrash}
      q={q}
      selected={selected}
      onSelect={(id) => setParam('thread', id)}
      onRemoved={(ids) => selected && ids.includes(selected) && setParam('thread', null)}
      unreadOnly={unreadOnly}
      onUnreadOnly={(on) => setParam('filter', on ? 'unread' : null)}
    />
  );

  if (accounts.data && accounts.data.length === 0) {
    return (
      <Flex align="center" justify="center" style={{ height: '100%' }}>
        <Empty description={t.mail.noAccounts}>
          <Button type="primary" onClick={() => navigate('/settings/accounts?add=1')}>
            {t.mail.addFirstAccount}
          </Button>
        </Empty>
      </Flex>
    );
  }

  return (
    <Flex vertical style={{ height: '100%' }}>
      <Flex align="center" gap={12} style={{ padding: '10px 16px', borderBottom: `1px solid ${token.colorSplit}`, flex: 'none' }}>
        {!narrow && (
          <Typography.Title level={5} ellipsis style={{ margin: 0, minWidth: 0, flex: '0 1 auto', maxWidth: 280 }}>
            {title}
          </Typography.Title>
        )}
        <SearchBox q={q} aiMode={aiMode} narrow={narrow} placeholder={aiMode ? t.mail.aiPlaceholder : narrow && !searching ? t.mail.searchIn(title) : t.mail.searchAll} onSearch={onSearch} />
      </Flex>
      {/* 搜索条件标签；侧栏点进来的单个分类、标签筛选标题已经写明，不再重复 */}
      {searching && !aiMode && (
        <div style={{ padding: '6px 16px', borderBottom: `1px solid ${token.colorSplit}`, flex: 'none' }}>
          <SearchConditions q={q} onChange={(next) => onSearch(next, false)} />
        </div>
      )}
      {narrow ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          {selected ? (
            <ThreadView key={selected} threadId={selected} inTrash={inTrash} onBack={() => setParam('thread', null)} onDone={() => setParam('thread', null)} />
          ) : (
            threadList
          )}
        </div>
      ) : (
        <Splitter style={{ flex: 1, minHeight: 0 }}>
          <Splitter.Panel defaultSize="38%" min={300} max="60%">
            {threadList}
          </Splitter.Panel>
          <Splitter.Panel min={360}>
            {selected ? (
              <ThreadView key={selected} threadId={selected} inTrash={inTrash} onDone={() => setParam('thread', null)} />
            ) : (
              <Flex align="center" justify="center" style={{ height: '100%' }}>
                <Empty description={t.mail.selectToRead} />
              </Flex>
            )}
          </Splitter.Panel>
        </Splitter>
      )}
    </Flex>
  );
}
