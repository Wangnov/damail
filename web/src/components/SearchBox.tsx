import { BulbOutlined, ClockCircleOutlined, CloseOutlined, QuestionCircleOutlined, SearchOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Flex, Input, Popover, Tag, Tooltip, Typography, type InputRef } from 'antd';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { api, type Address } from '../api';
import { useAccounts, useFolders, useLabels } from '../hooks/data';
import { t, useLocale } from '../i18n';
import { folderLabel } from '../lib/format';
import {
  CATEGORY_ZH,
  FOLDER_ZH,
  PRIORITY_ZH,
  dropHistory,
  hasToken,
  isZhText,
  keyOptions,
  localizeQuery,
  normalizeQuery,
  pushHistory,
  quoteValue,
  readHistory,
  relativeDate,
  removeToken,
  replaceWord,
  toggleToken,
  tokenize,
  valueMatches,
  valueSpelling,
  wordAt,
  type QueryToken,
  type SearchLang,
} from '../lib/search';
import { CATEGORY_META, PRIORITY_META } from './Insight';
import { labelName } from './Labels';
import { SenderAvatar } from './SenderAvatar';

/** 快捷筛选：点一下加上或去掉这个条件并立即搜索 */
const QUICK = ['is:unread', 'is:starred', 'has:attachment', 'is:needs-reply', 'after:today', 'after:7d', 'after:30d'];
const SPECIAL_FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash'] as const;
const DATE_VALUES = ['today', 'yesterday', '7d', '30d', '3m', '1y'];
const IS_VALUES = ['unread', 'read', 'starred', 'answered', 'needs-reply'];
const HAS_VALUES = ['attachment', 'code'];
/** 联系人、文件夹、标签这类可能很多的值最多列几个（分类等固定的值全部列出） */
const MAX_PER_GROUP = 8;

export const searchLang = (locale: string): SearchLang => (locale === 'zh-CN' ? 'zh' : 'en');

/** 相对日期的说明：after:today → 今天，after:7d → 近 7 天，before:7d → 早于近 7 天 */
function dateLabel(value: string, before = false): string | null {
  const r = relativeDate(value);
  const d = t.mail.search.dates;
  if (!r) return null;
  const label = r === 'today' || r === 'yesterday' ? d[r] : d[r.unit](r.n);
  return before ? d.earlier(label) : label;
}

/** 条件标签上的文字 */
export function tokenLabel(tk: QueryToken): string {
  const s = t.mail.search;
  const v = tk.value;
  let text: string;
  if (tk.key === 'is' || tk.key === 'has') text = s.flags[`${tk.key}:${v.toLowerCase()}`] ?? tk.text.replace(/^-/, '');
  else if (tk.key === 'after' && dateLabel(v)) text = dateLabel(v)!;
  else if (tk.key) {
    let shown = v;
    if (tk.key === 'category') shown = CATEGORY_META[v.toLowerCase()]?.label ?? v;
    else if (tk.key === 'priority') shown = PRIORITY_META[v.toLowerCase() as keyof typeof PRIORITY_META]?.label ?? v;
    else if (tk.key === 'folder') shown = (t.common.folders as Record<string, string>)[v.toLowerCase()] ?? v;
    text = tk.key === 'before' && dateLabel(v, true) ? dateLabel(v, true)! : `${s.keys[tk.key]} ${shown}`;
  } else return `${tk.neg ? s.exclude : s.keyword} ${tk.text.replace(/^-/, '')}`;
  return tk.neg ? `${s.not} ${text}` : text;
}

type Item = {
  id: string;
  /** complete：补全到光标处；quick / history：直接搜索 */
  kind: 'complete' | 'quick' | 'history';
  label: ReactNode;
  desc?: ReactNode;
  icon?: ReactNode;
  /** 快捷筛选是否已经在搜索语句里 */
  on?: boolean;
  run: () => void;
  onRemove?: () => void;
};
type Group = { key: string; title?: string; items: Item[]; hint?: string; chips?: boolean };

/** 分类、标签的颜色是 antd 的预设色名（red、geekblue、default），邮箱的颜色可能是色值 */
const colorOf = (color: string) =>
  /^(#|rgb|hsl|var\()/.test(color) ? color : color === 'default' ? 'var(--ant-color-text-quaternary)' : `var(--ant-${color}-6)`;
const dot = (color: string) => <span className="search-dot" style={{ background: colorOf(color) }} />;

/** 语法速查：每一项点一下插入到光标处 */
function SearchHelp({ onInsert }: { onInsert: (insert: string) => void }) {
  const s = t.mail.search;
  return (
    <div className="search-help">
      <div className="search-help-grid">
        {s.help.map((g) => (
          <div key={g.title}>
            <div className="search-group-title">{g.title}</div>
            {g.items.map((it) => (
              <button key={it.insert} type="button" className="search-help-item" onClick={() => onInsert(it.insert)}>
                <Typography.Text code>{it.label ?? it.insert}</Typography.Text>
                {it.desc && <span className="search-item-desc">{it.desc}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
        {s.alt}
        <br />
        {s.quoteTip}
      </Typography.Text>
    </div>
  );
}

type Props = {
  /** 当前搜索（英文语法，来自链接） */
  q: string;
  aiMode: boolean;
  narrow: boolean;
  placeholder: string;
  /** raw 是输入框里的原文；普通搜索由调用方换成英文语法 */
  onSearch: (raw: string, ai?: boolean) => void;
};

/**
 * 邮件列表顶部的搜索框：输入时补全条件和值，空着时给快捷筛选和最近搜索，
 * 「?」里的语法点一下就插入。中文界面显示中文写法，提交时换成英文语法（lib/search.ts）。
 */
export function SearchBox({ q, aiMode, narrow, placeholder, onSearch }: Props) {
  const lang = searchLang(useLocale());
  const s = t.mail.search;
  const accounts = useAccounts();
  const folders = useFolders();
  const labels = useLabels();
  const listId = useId();

  const display = aiMode ? q : localizeQuery(q, lang);
  const [input, setInput] = useState(display);
  useEffect(() => setInput(display), [display]);
  const [cursor, setCursor] = useState(display.length);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [history, setHistory] = useState(readHistory);
  const [helpOpen, setHelpOpen] = useState(false);
  const ref = useRef<InputRef>(null);
  const nextCursor = useRef<number | null>(null);

  // 补全后把光标放到插入内容的后面
  useLayoutEffect(() => {
    const el = ref.current?.input;
    if (el && nextCursor.current !== null) {
      el.setSelectionRange(nextCursor.current, nextCursor.current);
      setCursor(nextCursor.current);
      nextCursor.current = null;
    }
  }, [input]);

  // 在页面任意位置按 / 聚焦搜索框（正在输入或对话框里不抢）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest('[role="dialog"]'))) return;
      e.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const word = wordAt(input, cursor);

  // 发件人 / 收件人：按已经输入的部分联想联系人
  const contactKey = word.key === 'from' || word.key === 'to';
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const v = contactKey ? word.value.trim() : '';
    const id = window.setTimeout(() => setDebounced(v), 200);
    return () => window.clearTimeout(id);
  }, [contactKey, word.value]);
  const contacts = useQuery({
    queryKey: ['contacts', 'search', debounced],
    queryFn: () => api<Address[]>(`/api/v1/contacts?q=${encodeURIComponent(debounced)}`),
    enabled: open && contactKey && Boolean(debounced),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const submit = (raw: string) => {
    const norm = normalizeQuery(raw);
    if (norm) setHistory(pushHistory(norm));
    setOpen(false);
    setActive(-1);
    onSearch(raw, false);
  };

  const insert = (text: string, at = word) => {
    const res = replaceWord(input, at, text);
    // 插入引号时把光标放在两个引号中间
    nextCursor.current = text === '""' ? res.value.indexOf('""', at.start) + 1 : res.cursor;
    setInput(res.value);
    setActive(-1);
    setOpen(true);
  };

  // 每次渲染重新算（很便宜），这样 onSearch 等回调总是最新的
  const groups = ((): Group[] => {
    if (aiMode || word.inQuote) return [];
    const neg = word.neg ? '-' : '';
    const list: Group[] = [];

    // 光标在空白处：快捷筛选 + 最近搜索
    if (!word.text) {
      list.push({
        key: 'quick',
        title: s.quick,
        chips: true,
        items: QUICK.map((tk) => ({
          id: `quick-${tk}`,
          kind: 'quick',
          label: s.flags[tk],
          on: hasToken(input, tk),
          run: () => submit(localizeQuery(toggleToken(input, tk), lang)),
        })),
      });
      if (!input.trim() && history.length) {
        list.push({
          key: 'history',
          title: s.recent,
          items: history.map((h) => ({
            id: `history-${h}`,
            kind: 'history',
            icon: <ClockCircleOutlined />,
            label: localizeQuery(h, lang),
            run: () => submit(localizeQuery(h, lang)),
            onRemove: () => setHistory(dropHistory(h)),
          })),
        });
      }
      return list;
    }

    // 还没有冒号：联想条件名和状态词
    if (word.rawKey === null) {
      const typed = word.text.slice(neg.length);
      const items: Item[] = keyOptions(typed).map((o) => {
        const isKey = o.insert.endsWith(':');
        const k = o.canonical.replace(/:$/, '');
        return {
          id: `key-${o.canonical}`,
          kind: 'complete',
          label: <Typography.Text code>{neg + o.insert}</Typography.Text>,
          desc: isKey ? s.keyDesc[k] : (s.flagDesc[o.canonical] ?? s.flags[o.canonical]),
          run: () => insert(neg + o.insert),
        };
      });
      return items.length ? [{ key: 'keys', title: s.conditions, items }] : [];
    }

    // 有冒号：联想值
    const key = word.key;
    if (!key) return [];
    const typed = word.value;
    const vLang: SearchLang = isZhText(word.rawKey) ? 'zh' : 'en';
    const prefix = `${neg}${word.rawKey}:`;
    const complete = (id: string, canonical: string, label: ReactNode, extra: Partial<Item> = {}): Item => ({
      id: `value-${id}`,
      kind: 'complete',
      label,
      run: () => insert(prefix + valueSpelling(key, canonical, vLang)),
      ...extra,
    });
    let items: Item[] = [];
    let hint: string | undefined;
    if (key === 'category') {
      items = Object.keys(CATEGORY_META)
        .filter((k) => valueMatches(typed, k, CATEGORY_ZH[k], CATEGORY_META[k]!.label))
        .map((k) => complete(k, k, CATEGORY_META[k]!.label, { icon: dot(CATEGORY_META[k]!.color) }));
    } else if (key === 'priority') {
      items = (['high', 'normal', 'low'] as const)
        .filter((k) => valueMatches(typed, k, PRIORITY_ZH[k], PRIORITY_META[k].label))
        .map((k) => complete(k, k, PRIORITY_META[k].label));
    } else if (key === 'folder') {
      const special = SPECIAL_FOLDERS.filter((k) => valueMatches(typed, k, FOLDER_ZH[k], t.common.folders[k])).map((k) =>
        complete(k, k, t.common.folders[k], { desc: vLang === 'en' ? k : undefined }),
      );
      const seen = new Set<string>();
      const custom = (folders.data ?? [])
        .filter((f) => !f.specialUse && f.path.toUpperCase() !== 'INBOX' && valueMatches(typed, f.name, f.path))
        .filter((f) => !seen.has(f.name) && Boolean(seen.add(f.name)))
        .map((f) => ({
          id: `folder-${f.id}`,
          kind: 'complete' as const,
          label: folderLabel(f),
          desc: accounts.data?.find((a) => a.id === f.accountId)?.name,
          run: () => insert(prefix + quoteValue(f.name)),
        }));
      items = [...special, ...custom];
    } else if (key === 'account') {
      items = (accounts.data ?? [])
        .filter((a) => valueMatches(typed, a.name, a.email, a.provider))
        .map((a) => ({
          id: `account-${a.id}`,
          kind: 'complete',
          icon: dot(a.color ?? 'var(--ant-color-primary)'),
          label: a.name,
          desc: a.email,
          run: () => insert(prefix + quoteValue(a.email)),
        }));
    } else if (key === 'label') {
      items = (labels.data ?? [])
        .filter((l) => valueMatches(typed, labelName(l), l.name, ...Object.values(l.names ?? {})))
        .map((l) => ({
          id: `label-${l.id}`,
          kind: 'complete',
          icon: dot(l.color),
          label: labelName(l),
          run: () => insert(prefix + quoteValue(labelName(l))),
        }));
    } else if (key === 'after' || key === 'before') {
      const before = key === 'before';
      items = DATE_VALUES.filter((v) => valueMatches(typed, v, valueSpelling(key, v, 'zh'), dateLabel(v, before))).map((v) => {
        const label = dateLabel(v, before)!;
        const spelled = valueSpelling(key, v, vLang);
        // 说明里写实际插入的值；和标题一样时不重复
        return complete(v, v, label, { desc: label.replace(/\s/g, '') === spelled ? undefined : spelled });
      });
      hint = s.dateHint;
    } else if (key === 'is' || key === 'has') {
      items = (key === 'is' ? IS_VALUES : HAS_VALUES)
        .filter((v) => valueMatches(typed, v, s.flags[`${key}:${v}`]))
        .map((v) => ({
          id: `flag-${key}-${v}`,
          kind: 'complete',
          label: s.flags[`${key}:${v}`],
          desc: `${key}:${v}`,
          run: () => insert(`${neg}${key}:${v}`),
        }));
    } else if (key === 'from' || key === 'to') {
      if (!typed.trim()) hint = s.typeToSearchContacts;
      else {
        items = (contacts.data ?? []).filter((c) => c.address).map((c) => ({
          id: `contact-${c.address}`,
          kind: 'complete',
          icon: <SenderAvatar address={c.address ?? null} name={c.alias || c.name || c.address!} size={22} />,
          label: c.alias || c.name || c.address,
          desc: c.alias || c.name ? c.address : undefined,
          run: () => insert(prefix + quoteValue(c.address!)),
        }));
        if (!items.length && !contacts.isFetching && contacts.isFetched) hint = s.noContacts;
      }
    }
    const title = key === 'from' || key === 'to' ? s.contacts : (s.keys[key] ?? key);
    if (!items.length && !hint) return [];
    const max = key === 'category' ? items.length : MAX_PER_GROUP;
    return [{ key: 'values', title, items: items.slice(0, max), hint }];
  })();

  const flat = groups.flatMap((g) => g.items);
  // 「?」速查打开时不显示补全（点「?」时输入框会先拿到焦点）
  const showPanel = open && !helpOpen && groups.length > 0;
  const activeItem = showPanel && active >= 0 ? flat[active] : undefined;
  const isCompleting = flat.some((i) => i.kind === 'complete');

  const syncCursor = () => {
    const el = ref.current?.input;
    if (el) setCursor(el.selectionStart ?? el.value.length);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const n = flat.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!showPanel) {
        setOpen(true);
        return;
      }
      if (!n) return;
      e.preventDefault();
      setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % n : i <= 0 ? n - 1 : i - 1));
    } else if (e.key === 'Tab' && !e.shiftKey && showPanel && isCompleting) {
      e.preventDefault();
      (activeItem ?? flat[0])?.run();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeItem) activeItem.run();
      else if (aiMode) onSearch(input, true);
      else submit(input);
    } else if (e.key === 'Escape') {
      if (showPanel) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      } else ref.current?.blur();
    }
  };

  const renderItem = (item: Item, index: number) => {
    const selected = index === active;
    const common = {
      id: `${listId}-${index}`,
      role: 'option' as const,
      'aria-selected': selected,
      // 不让输入框失去焦点
      onMouseDown: (e: ReactMouseEvent) => e.preventDefault(),
      onMouseEnter: () => setActive(index),
      onClick: item.run,
    };
    if (item.kind === 'quick') {
      return (
        <span key={item.id} {...common} className={`search-chip${selected ? ' active' : ''}${item.on ? ' on' : ''}`}>
          {item.label}
        </span>
      );
    }
    return (
      <div key={item.id} {...common} className={`search-item${selected ? ' active' : ''}`}>
        {item.icon && <span className="search-item-icon">{item.icon}</span>}
        <span className="search-item-label">{item.label}</span>
        {item.desc && <span className="search-item-desc">{item.desc}</span>}
        {item.onRemove && (
          <Button
            size="small"
            type="text"
            className="search-item-remove"
            icon={<CloseOutlined />}
            aria-label={s.removeRecent}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              item.onRemove!();
            }}
          />
        )}
      </div>
    );
  };

  let index = 0;
  return (
    <div className="mail-search-box" style={{ flex: 1, minWidth: 0, maxWidth: 600, marginLeft: 'auto', position: 'relative' }}>
      <Input
        ref={ref}
        className="mail-search"
        variant="filled"
        allowClear
        placeholder={placeholder}
        prefix={<SearchOutlined />}
        value={input}
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeItem ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          setInput(e.target.value);
          setCursor(e.target.selectionStart ?? e.target.value.length);
          setActive(-1);
          setOpen(true);
          // 点清除按钮：同时清掉搜索结果
          if (!e.target.value && e.type !== 'change' && q) onSearch('');
        }}
        onSelect={syncCursor}
        onClick={() => {
          syncCursor();
          setOpen(true);
        }}
        onFocus={() => {
          syncCursor();
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
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
            <Popover
              open={helpOpen}
              onOpenChange={setHelpOpen}
              trigger="click"
              content={
                <SearchHelp
                  onInsert={(text) => {
                    setHelpOpen(false);
                    // 光标在词中间时插到这个词后面
                    const at = word.text ? { ...word, start: word.end } : word;
                    insert(text, at);
                    ref.current?.focus();
                  }}
                />
              }
              title={t.mail.searchSyntax}
              placement="bottomRight"
            >
              <Button size="small" type="text" className="mail-search-help" icon={<QuestionCircleOutlined />} aria-label={t.mail.searchSyntax} />
            </Popover>
          </Flex>
        }
      />
      {showPanel && (
        <div className="search-panel" id={listId} role="listbox" onMouseDown={(e) => e.preventDefault()}>
          {groups.map((g) => (
            <div key={g.key} className="search-group" role="group" aria-label={g.title}>
              {g.title && (
                <div className="search-group-title">
                  <span>{g.title}</span>
                  {g.key === 'history' && (
                    <button type="button" className="search-group-action" onClick={() => setHistory(dropHistory(null))}>
                      {s.clearRecent}
                    </button>
                  )}
                </div>
              )}
              {g.chips ? <div className="search-chips">{g.items.map((it) => renderItem(it, index++))}</div> : g.items.map((it) => renderItem(it, index++))}
              {g.hint && <div className="search-hint">{g.hint}</div>}
            </div>
          ))}
          {!narrow && (
            <div className="search-footer">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> {s.keyHint.move}
              </span>
              {isCompleting && (
                <span>
                  <kbd>Tab</kbd> {s.keyHint.tab}
                </span>
              )}
              <span>
                <kbd>Enter</kbd> {s.keyHint.enter}
              </span>
              <span>
                <kbd>Esc</kbd> {s.keyHint.esc}
              </span>
              <span style={{ marginInlineStart: 'auto' }}>
                <kbd>/</kbd> {s.keyHint.slash}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 搜索条件标签：每个条件一个，点 × 去掉并重新搜索 */
export function SearchConditions({ q, onChange }: { q: string; onChange: (q: string) => void }) {
  const s = t.mail.search;
  const tokens = tokenize(q);
  if (!tokens.length) return null;
  return (
    <div className="search-conditions">
      {tokens.map((tk, i) => {
        const label = tokenLabel(tk);
        return (
          <Tag
            key={`${i}-${tk.text}`}
            color={tk.neg ? 'default' : 'processing'}
            variant="filled"
            closable
            closeIcon={<CloseOutlined aria-label={s.removeCondition(label)} />}
            onClose={(e) => {
              e.preventDefault();
              onChange(removeToken(q, i));
            }}
          >
            {label}
          </Tag>
        );
      })}
      {tokens.length > 1 && (
        <Button size="small" type="link" onClick={() => onChange('')}>
          {s.clearAll}
        </Button>
      )}
    </div>
  );
}
