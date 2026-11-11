import { BulbOutlined } from '@ant-design/icons';
import { Flex, Tag, Tooltip, Typography, theme } from 'antd';
import type { MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { categoryQuery, NEEDS_REPLY_Q } from '../lib/search';
import type { Category, Insight, InsightBrief } from '../api';
import { intlLocale, pickText, t } from '../i18n';

const CATEGORY_COLORS = {
  important: 'red',
  work: 'blue',
  personal: 'green',
  finance: 'gold',
  verification: 'purple',
  shipping: 'cyan',
  notification: 'default',
  social: 'geekblue',
  marketing: 'default',
  spam: 'default',
} as const;
type CategoryKey = keyof typeof CATEGORY_COLORS;

/** 服务端的分类目录（GET /api/v1/categories，useCategories 拿到后填进来）；没拿到前用本地文案 */
let catalog: Map<string, Category> | null = null;
export const setCategoryCatalog = (list: Category[]) => {
  catalog = new Map(list.map((c) => [c.key, c]));
};

/** 分类的颜色和名字；label 是 getter，按当前界面语言取 */
export const CATEGORY_META: Record<string, { label: string; color: string }> = Object.fromEntries(
  (Object.keys(CATEGORY_COLORS) as CategoryKey[]).map((k) => [
    k,
    {
      get color() {
        return catalog?.get(k)?.color ?? CATEGORY_COLORS[k];
      },
      get label() {
        return pickText(catalog?.get(k)?.i18n)?.name || t.insight.categories[k];
      },
    },
  ]),
);

export const PRIORITY_META = {
  high: {
    color: 'red',
    get label() {
      return t.insight.priority.high;
    },
  },
  normal: {
    color: 'default',
    get label() {
      return t.insight.priority.normal;
    },
  },
  low: {
    color: 'default',
    get label() {
      return t.insight.priority.low;
    },
  },
} as const;

/** 点标签筛出同类邮件：重要、需回复走现成的视图，分类用搜索 */
export const INSIGHT_LINK = {
  important: '/mail?view=important',
  needsReply: `/mail?view=inbox&q=${encodeURIComponent(NEEDS_REPLY_Q)}`,
  category: (c: string) => `/mail?view=all&q=${encodeURIComponent(categoryQuery(c))}`,
};

/** 标签点击：不触发外层（列表行会打开会话），跳到筛选结果 */
function useTagLink() {
  const navigate = useNavigate();
  return (to: string, title: string) => ({
    title,
    className: 'insight-tag-link',
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      navigate(to);
    },
  });
}

/** 列表里的分类标签：高优先级和需回复额外标出，营销/通知这类低价值分类不显示，避免满屏标签；点标签筛出同类邮件 */
export function InsightTags({ insight }: { insight: InsightBrief | null }) {
  const link = useTagLink();
  if (!insight) return null;
  const meta = CATEGORY_META[insight.category];
  const quiet = ['notification', 'marketing', 'spam', 'social'].includes(insight.category);
  const style = { marginInlineEnd: 0, fontSize: 11 };
  return (
    <>
      {insight.priority === 'high' && (
        <Tag color="red" style={style} {...link(INSIGHT_LINK.important, t.insight.viewImportant)}>
          {t.insight.important}
        </Tag>
      )}
      {meta && !quiet && insight.category !== 'important' && (
        <Tag color={meta.color} style={style} {...link(INSIGHT_LINK.category(insight.category), t.insight.viewCategory(meta.label))}>
          {meta.label}
        </Tag>
      )}
      {insight.needsReply && (
        <Tag color="orange" style={style} {...link(INSIGHT_LINK.needsReply, t.insight.viewNeedsReply)}>
          {t.insight.needsReplyShort}
        </Tag>
      )}
    </>
  );
}

function money(a: Insight['extracted']['amounts'][number]) {
  let value: string;
  try {
    value = new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: a.currency }).format(a.value);
  } catch {
    // 模型偶尔给出非 ISO 币种代码
    value = `${a.currency} ${a.value.toLocaleString(intlLocale(), { maximumFractionDigits: 2 })}`;
  }
  return a.label ? `${a.label} ${value}` : value;
}

/** linkable：标签可以点击筛出同类邮件（读信时用；模型测试结果里不用） */
export function InsightCard({ insight, linkable = false }: { insight: Insight; linkable?: boolean }) {
  const { token } = theme.useToken();
  const tagLink = useTagLink();
  const link = (to: string, title: string) => (linkable ? tagLink(to, title) : {});
  const ex = insight.extracted;
  const meta = CATEGORY_META[insight.category];
  const rows: [string, React.ReactNode][] = [];
  if (ex.codes.length)
    rows.push([
      t.insight.codes,
      <Flex gap={12} wrap key="codes">
        {ex.codes.map((c) => (
          <Typography.Text key={c} copyable strong style={{ fontSize: 16, letterSpacing: 1 }}>
            {c}
          </Typography.Text>
        ))}
      </Flex>,
    ]);
  if (ex.amounts.length) rows.push([t.insight.amounts, ex.amounts.map(money).join(t.insight.amountSep)]);
  if (ex.dueDate) rows.push([t.insight.dueDate, ex.dueDate]);
  if (ex.trackingNumbers.length)
    rows.push([
      t.insight.tracking,
      <Flex gap={12} wrap key="tracking">
        {ex.trackingNumbers.map((n) => (
          <Typography.Text key={n} copyable>
            {n}
          </Typography.Text>
        ))}
      </Flex>,
    ]);
  if (ex.actionItems.length)
    rows.push([
      t.insight.todo,
      <ul key="todo" style={{ margin: 0, paddingInlineStart: 18 }}>
        {ex.actionItems.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>,
    ]);

  return (
    <div className="insight-card">
      <Flex align="center" gap={8} wrap style={{ marginBottom: insight.summary || rows.length ? 6 : 0 }}>
        <BulbOutlined style={{ color: token.colorPrimary }} />
        <Typography.Text strong>{t.insight.aiSummary}</Typography.Text>
        {meta && (
          <Tag color={meta.color} {...link(INSIGHT_LINK.category(insight.category), t.insight.viewCategory(meta.label))}>
            {meta.label}
          </Tag>
        )}
        {insight.priority !== 'normal' && (
          <Tag color={PRIORITY_META[insight.priority].color} {...(insight.priority === 'high' ? link(INSIGHT_LINK.important, t.insight.viewImportant) : {})}>
            {t.insight.priorityTag(PRIORITY_META[insight.priority].label)}
          </Tag>
        )}
        {insight.needsReply && (
          <Tag color="orange" {...link(INSIGHT_LINK.needsReply, t.insight.viewNeedsReply)}>
            {t.insight.needsReply}
          </Tag>
        )}
        <Tooltip title={t.insight.generatedBy(insight.model)}>
          <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 'auto' }}>
            {insight.model}
          </Typography.Text>
        </Tooltip>
      </Flex>
      {insight.summary && <Typography.Paragraph style={{ marginBottom: rows.length ? 6 : 0 }}>{insight.summary}</Typography.Paragraph>}
      {rows.map(([label, value]) => (
        <Flex key={label} gap={12} style={{ marginTop: 4 }}>
          <Typography.Text type="secondary" style={{ width: 64, flex: 'none' }}>
            {label}
          </Typography.Text>
          <div style={{ minWidth: 0 }}>{value}</div>
        </Flex>
      ))}
    </div>
  );
}
