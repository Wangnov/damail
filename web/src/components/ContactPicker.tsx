import { CheckOutlined, SearchOutlined } from '@ant-design/icons';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Button, Empty, Input, Modal, Segmented, Spin } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { api, type ContactRow } from '../api';
import { t } from '../i18n';
import { formatAddress } from '../lib/format';
import { SenderAvatar } from './SenderAvatar';

const PAGE = 50;

/** 「名字 <地址>」或纯地址里取出邮箱地址（小写），用来判断是否已经添加 */
export const addressOf = (s: string) => (/<([^<>]+)>\s*$/.exec(s)?.[1] ?? s).trim().toLowerCase();

/** 从通讯录挑收件人：可搜索、多选；已经在输入框里的地址显示为已添加 */
export function ContactPicker({
  open,
  title,
  existing,
  onClose,
  onPick,
}: {
  open: boolean;
  title: string;
  /** 输入框里已有的收件人 */
  existing: string[];
  onClose: () => void;
  onPick: (values: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<'sent' | 'recent'>('sent');
  const [picked, setPicked] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(id);
  }, [q]);

  // 每次打开都从头选
  useEffect(() => {
    if (open) {
      setQ('');
      setDebounced('');
      setPicked(new Map());
    }
  }, [open]);

  const list = useInfiniteQuery({
    queryKey: ['contacts', 'picker', debounced, sort],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ sort, people: '1', limit: String(PAGE), offset: String(pageParam) });
      if (debounced) p.set('q', debounced);
      return api<{ total: number; items: ContactRow[] }>(`/api/admin/contacts?${p}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, pg) => n + pg.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  // 服务端已去掉忽略名单和 no-reply 这类不能回信的地址
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const have = useMemo(() => new Set(existing.map(addressOf)), [existing]);

  const toggle = (r: ContactRow) =>
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(r.address)) next.delete(r.address);
      else next.set(r.address, formatAddress({ name: r.name ?? undefined, address: r.address }));
      return next;
    });

  const submit = () => {
    if (picked.size) onPick([...picked.values()]);
    onClose();
  };

  return (
    <Modal
      open={open}
      title={title}
      width={520}
      onCancel={onClose}
      destroyOnHidden
      rootClassName="contact-picker"
      footer={
        <div className="contact-picker-foot">
          <span>{picked.size ? t.compose.pickedCount(picked.size) : t.compose.pickHint}</span>
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button type="primary" disabled={!picked.size} onClick={submit}>
            {t.compose.addPicked(picked.size)}
          </Button>
        </div>
      }
    >
      <div className="contact-picker-tools">
        <Input
          autoFocus
          allowClear
          prefix={<SearchOutlined />}
          placeholder={t.compose.searchContacts}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onPressEnter={() => {
            // 搜到唯一一个时回车直接勾上
            if (rows.length === 1 && !have.has(rows[0]!.address)) toggle(rows[0]!);
          }}
        />
        <Segmented
          value={sort}
          onChange={(v) => setSort(v as 'sent' | 'recent')}
          options={[
            { value: 'sent', label: t.compose.sortFrequent },
            { value: 'recent', label: t.compose.sortRecent },
          ]}
        />
      </div>
      <div className="contact-picker-list" role="listbox" aria-multiselectable="true">
        {list.isLoading ? (
          <div className="contact-picker-empty">
            <Spin />
          </div>
        ) : rows.length === 0 ? (
          <div className="contact-picker-empty">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t.compose.noContacts} />
          </div>
        ) : (
          rows.map((r) => {
            const added = have.has(r.address);
            const on = picked.has(r.address);
            return (
              <button
                key={r.address}
                type="button"
                role="option"
                aria-selected={on || added}
                disabled={added}
                className={`contact-picker-item${on ? ' on' : ''}${added ? ' added' : ''}`}
                onClick={() => toggle(r)}
              >
                <SenderAvatar address={r.address} name={r.name || r.address} size={32} />
                <span className="contact-picker-text">
                  <b>{r.alias || r.name || r.address}</b>
                  {(r.alias || r.name) && <span>{r.alias && r.name ? `${r.name} · ${r.address}` : r.address}</span>}
                </span>
                {added ? (
                  <span className="contact-picker-added">{t.compose.alreadyAdded}</span>
                ) : (
                  <span className="contact-picker-stats">{t.compose.contactStats(r.received, r.sent)}</span>
                )}
                <span className="contact-picker-check" aria-hidden="true">
                  {(on || added) && <CheckOutlined />}
                </span>
              </button>
            );
          })
        )}
        {list.hasNextPage && (
          <Button type="text" block loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} style={{ marginTop: 4 }}>
            {t.compose.loadMore}
          </Button>
        )}
      </div>
    </Modal>
  );
}
