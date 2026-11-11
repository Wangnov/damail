import { BulbOutlined, QuestionCircleOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Empty, Flex, Grid, Input, Popover, Splitter, Tooltip, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AiSearchResults } from '../components/AiSearchResults';
import { ThreadList } from '../components/ThreadList';
import { ThreadView } from '../components/ThreadView';
import { useAccounts, useFolders, useLabels } from '../hooks/data';
import { labelHasName, labelName as nameOf } from '../components/Labels';
import { folderLabel } from '../lib/format';
import { categoryOfQuery, labelOfQuery, normalizeQuery } from '../lib/search';
import { CATEGORY_META } from '../components/Insight';
import { t } from '../i18n';

// 中文写法提交时会换成英文语法（见 lib/search.ts），两种写法都能用；说明按界面语言显示一种
function SearchHelp() {
  const h = t.mail.help;
  const rows = (lines: string[][]) =>
    lines.map((line, i) => (
      <div key={i}>
        {line.map((code) => (
          <Typography.Text key={code} code style={{ marginInlineEnd: 4 }}>
            {code}
          </Typography.Text>
        ))}
      </div>
    ));
  return (
    <div style={{ maxWidth: 380, lineHeight: 1.9 }}>
      {rows(h.basic)}
      <Typography.Text type="secondary">{h.withAi}</Typography.Text>
      {rows(h.ai)}
      <Typography.Text type="secondary" style={{ display: 'block' }}>
        {h.categories}
      </Typography.Text>
      <Typography.Text type="secondary">{h.alt}</Typography.Text>
    </div>
  );
}

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
  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);

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
  } else if (q) title = aiMode ? t.mail.aiSearchTitle(q) : t.mail.searchTitle(q);

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
        <Input
          className="mail-search"
          variant="filled"
          allowClear
          placeholder={aiMode ? t.mail.aiPlaceholder : narrow ? t.mail.searchIn(title) : t.mail.searchAll}
          prefix={<SearchOutlined />}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            // 点清除按钮：同时清掉搜索结果
            if (!e.target.value && e.type !== 'change' && q) onSearch('');
          }}
          onPressEnter={() => onSearch(input)}
          suffix={
            <Flex align="center" gap={2}>
              <Tooltip title={aiMode ? t.mail.backToPlain : t.mail.aiSearchHint}>
                <Button
                  size="small"
                  type="text"
                  className={`mail-search-ai${aiMode ? ' on' : ''}`}
                  icon={<BulbOutlined />}
                  aria-pressed={aiMode}
                  disabled={!aiMode && !input.trim()}
                  onClick={() => onSearch(aiMode ? q : input, !aiMode)}
                >
                  {!narrow && t.mail.aiSearch}
                </Button>
              </Tooltip>
              <Popover content={<SearchHelp />} title={t.mail.searchSyntax} placement="bottomRight">
                <Button size="small" type="text" className="mail-search-help" icon={<QuestionCircleOutlined />} aria-label={t.mail.searchSyntax} />
              </Popover>
            </Flex>
          }
          style={{ maxWidth: 600, marginLeft: 'auto' }}
        />
      </Flex>
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
