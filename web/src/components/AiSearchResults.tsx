import { BulbOutlined, PaperClipOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Flex, Skeleton, Tag, Typography, theme } from 'antd';
import { useNavigate } from 'react-router';
import { api, type SemanticSearchResult } from '../api';
import { useAccounts } from '../hooks/data';
import { colorFor, shortDate } from '../lib/format';
import { EmptyBlock } from './EmptyBlock';
import { t } from '../i18n';

type Props = { q: string; selected: string | null; onSelect: (threadId: string) => void; onPlain: () => void };

/** AI 搜索结果：每次查询调用两次模型，结果缓存到页面刷新为止 */
export function AiSearchResults({ q, selected, onSelect, onPlain }: Props) {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const accounts = useAccounts();
  const multiAccount = (accounts.data?.length ?? 0) > 1;
  const accountById = new Map((accounts.data ?? []).map((a) => [a.id, a]));
  const res = useQuery({
    queryKey: ['semantic', q],
    queryFn: () => api<SemanticSearchResult>('/api/v1/search/semantic', { method: 'POST', body: { q, limit: 20 } }),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });

  if (res.isPending) {
    return (
      <div style={{ padding: 16 }}>
        <Typography.Text type="secondary">
          <BulbOutlined /> {t.unsubscribe.aiThinking}
        </Typography.Text>
        <Skeleton active paragraph={{ rows: 6 }} style={{ marginTop: 16 }} />
      </div>
    );
  }
  if (res.isError) {
    const notEnabled = /AI 未启用|AI is not enabled/.test(res.error.message);
    return (
      <div style={{ padding: 16 }}>
        <Alert
          type={notEnabled ? 'info' : 'error'}
          showIcon
          title={notEnabled ? t.unsubscribe.aiNeedsSetup : res.error.message}
          action={
            notEnabled ? (
              <Button size="small" onClick={() => navigate('/ai/models')}>
                {t.unsubscribe.goSetup}
              </Button>
            ) : (
              <Button size="small" onClick={() => res.refetch()}>
                {t.common.retry}
              </Button>
            )
          }
        />
        <Button type="link" onClick={onPlain} style={{ paddingInline: 0, marginTop: 8 }}>
          {t.unsubscribe.plainSearch}
        </Button>
      </div>
    );
  }

  const r = res.data;
  return (
    <Flex vertical style={{ height: '100%' }}>
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${token.colorSplit}`, flex: 'none' }}>
        <Typography.Text style={{ fontSize: 13 }}>
          <BulbOutlined style={{ color: token.colorPrimary, marginRight: 6 }} />
          {r.intent || q}
        </Typography.Text>
        <Flex wrap gap={4} style={{ marginTop: 6 }}>
          {r.filters &&
            r.filters.split(' ').map((f) => (
              <Tag key={f} color="blue" style={{ marginInlineEnd: 0, fontSize: 12 }}>
                {f}
              </Tag>
            ))}
          {r.keywords.map((g) => (
            <Tag key={g.join('|')} style={{ marginInlineEnd: 0, fontSize: 12 }}>
              {g.join(' / ')}
            </Tag>
          ))}
        </Flex>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
          {t.unsubscribe.picked(r.candidates, r.items.length)}
          {r.relaxed === 'keywords' && t.unsubscribe.relaxedKeywords}
          {r.relaxed === 'filters' && t.unsubscribe.relaxedFilters}
          {' · '}
          <Typography.Link style={{ fontSize: 12 }} onClick={onPlain}>
            {t.unsubscribe.plainSearch}
          </Typography.Link>
        </Typography.Text>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {r.items.length === 0 ? (
          <EmptyBlock description={t.unsubscribe.noResults} />
        ) : (
          r.items.map((i) => {
            const acc = accountById.get(i.accountId);
            return (
              <div
                key={i.id}
                className={`thread-item${i.threadId === selected ? ' active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(i.threadId)}
                onKeyDown={(e) => e.key === 'Enter' && onSelect(i.threadId)}
              >
                <div className="thread-body">
                  <div className="line">
                    {!i.seen ? <span className="unread-dot" /> : <span style={{ width: 8, flex: 'none' }} />}
                    <Typography.Text strong={!i.seen} className="ellipsis" style={{ flex: 1 }}>
                      {i.fromName || i.fromAddress || t.unsubscribe.unknown}
                    </Typography.Text>
                    {i.hasAttachments && <PaperClipOutlined style={{ color: token.colorTextTertiary }} />}
                    <Typography.Text type="secondary" style={{ fontSize: 12, flex: 'none' }}>
                      {shortDate(i.date)}
                    </Typography.Text>
                  </div>
                  <div className="line" style={{ paddingLeft: 14, marginTop: 2 }}>
                    <Typography.Text strong={!i.seen} className="ellipsis" style={{ flex: 1 }}>
                      {i.subject || t.unsubscribe.noSubject}
                    </Typography.Text>
                    {multiAccount && acc && (
                      <span className="thread-account" title={acc.email}>
                        <i style={{ background: acc.color ?? colorFor(acc.id) }} />
                        <span>{acc.name}</span>
                      </span>
                    )}
                  </div>
                  <div style={{ paddingLeft: 14, marginTop: 2, fontSize: 13, color: token.colorTextSecondary }}>{i.reason || i.summary || i.snippet}</div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </Flex>
  );
}
