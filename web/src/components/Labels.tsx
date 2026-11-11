import { CheckOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Flex, Select, Tag, Tooltip, theme } from 'antd';
import { useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type LabelBrief } from '../api';
import { useLabels } from '../hooks/data';
import { pickText, t, useLocale } from '../i18n';
import { labelQuery } from '../lib/search';

export const labelUrl = (name: string) => `/mail?view=all&q=${encodeURIComponent(labelQuery(name))}`;

/** 标签在当前界面语言下的名称（切换语言不用重新请求） */
export const labelName = (l: { name: string; names?: LabelBrief['names'] }) => pickText(l.names) || l.name;

/** 名称是否属于这个标签（任意语言，不分大小写）：搜索 label:xxx 时用 */
export const labelHasName = (l: { name: string; names?: LabelBrief['names'] }, name: string) =>
  [l.name, ...Object.values(l.names ?? {})].some((n) => n?.toLowerCase() === name.toLowerCase());

/** 标签可选的颜色（和服务端 LABEL_COLORS 一致，用 antd 预设色） */
export const LABEL_COLORS = ['blue', 'green', 'orange', 'purple', 'cyan', 'magenta', 'gold', 'geekblue', 'volcano', 'lime'] as const;

/** 列表里的标签：最多显示 max 个，其余折成 +N；点标签筛出同标签的邮件 */
export function LabelTags({ labels, max = 2 }: { labels: LabelBrief[] | undefined; max?: number }) {
  const navigate = useNavigate();
  useLocale();
  if (!labels?.length) return null;
  const shown = labels.slice(0, max);
  const rest = labels.slice(max);
  const style = { marginInlineEnd: 0, fontSize: 11 };
  return (
    <>
      {shown.map((l) => (
        <Tag
          key={l.id}
          color={l.color}
          variant="outlined"
          style={style}
          className="insight-tag-link"
          title={t.labels.viewLabel(labelName(l))}
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            navigate(labelUrl(labelName(l)));
          }}
        >
          {labelName(l)}
        </Tag>
      ))}
      {rest.length > 0 && (
        <Tooltip title={rest.map(labelName).join(t.labels.listSep)}>
          <Tag style={style}>+{rest.length}</Tag>
        </Tooltip>
      )}
    </>
  );
}

/** 颜色选择：一排圆形色块，选中的带勾和外圈 */
export function ColorChoice({ value, onChange }: { value?: string; onChange?: (v: string) => void }) {
  const { token } = theme.useToken();
  const palette = token as unknown as Record<string, string>;
  return (
    <Flex gap={8} wrap role="radiogroup">
      {LABEL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          className="label-color"
          style={{ background: palette[c], boxShadow: value === c ? `0 0 0 2px ${token.colorBgElevated}, 0 0 0 4px ${palette[c]}` : undefined }}
          onClick={() => onChange?.(c)}
        >
          {value === c && <CheckOutlined />}
        </button>
      ))}
    </Flex>
  );
}

/** 邮件详情里的标签：可以去掉、添加；手动改动优先于 AI */
export function MessageLabels({ messageId, threadId, labels }: { messageId: number; threadId: string; labels: LabelBrief[] }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const all = useLabels();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const save = useMutation({
    mutationFn: (body: { add?: number[]; remove?: number[] }) => api(`/api/v1/messages/${messageId}/labels`, { method: 'PUT', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['thread', threadId] });
      qc.invalidateQueries({ queryKey: ['threads'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['labels'] });
    },
    onError: (e) => message.error((e as Error).message),
  });
  // 一个标签都没有时不占位置
  if (!all.data?.length && !labels.length) return null;
  const have = new Set(labels.map((l) => l.id));
  const options = (all.data ?? [])
    .filter((l) => !have.has(l.id))
    .map((l) => ({ value: l.id, label: <Tag color={l.color}>{labelName(l)}</Tag>, name: labelName(l) }));
  return (
    <Flex gap={6} wrap align="center" className="message-labels">
      {labels.map((l) => (
        <Tag
          key={l.id}
          color={l.color}
          style={{ marginInlineEnd: 0, cursor: 'pointer' }}
          title={t.labels.viewLabel(labelName(l))}
          onClick={() => navigate(labelUrl(labelName(l)))}
          closeIcon={<Tooltip title={t.labels.removeTip}>×</Tooltip>}
          onClose={(e) => {
            e.preventDefault();
            e.stopPropagation();
            save.mutate({ remove: [l.id] });
          }}
        >
          {labelName(l)}
        </Tag>
      ))}
      {adding ? (
        <Select
          size="small"
          autoFocus
          defaultOpen
          showSearch={{ optionFilterProp: 'name' }}
          style={{ width: 160 }}
          placeholder={t.labels.addPlaceholder}
          options={options}
          onBlur={() => setAdding(false)}
          onChange={(id: number) => {
            setAdding(false);
            save.mutate({ add: [id] });
          }}
          notFoundContent={<Link to="/ai/labels">{t.labels.manage}</Link>}
        />
      ) : (
        <Tag style={{ marginInlineEnd: 0, borderStyle: 'dashed', cursor: 'pointer', background: 'transparent' }} onClick={() => setAdding(true)}>
          <PlusOutlined /> {t.labels.add}
        </Tag>
      )}
    </Flex>
  );
}
