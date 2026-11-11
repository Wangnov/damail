import { LockOutlined } from '@ant-design/icons';
import { Button, Drawer, Empty, Flex, Space, Table, Tabs, Tag, Typography, theme } from 'antd';
import { useState } from 'react';
import type { PromptItem } from '../../api';
import { TableFill } from '../../components/TableFill';
import { usePrompts } from '../../hooks/data';
import { LOCALES, pickText, t, useLocale, type Locale } from '../../i18n';
import { fromNow } from '../../lib/format';

/** 提示词正文：{{变量}} 高亮 */
function PromptText({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <pre className="prompt-text" style={{ background: token.colorFillTertiary, borderRadius: token.borderRadius }}>
      {text.split(/(\{\{\w+\}\})/).map((part, i) =>
        /^\{\{\w+\}\}$/.test(part) ? (
          <mark key={i} style={{ background: token.colorPrimaryBg, color: token.colorPrimaryText, borderRadius: 3, padding: '0 2px' }}>
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </pre>
  );
}

/** 系统内置的提示词：只读，按语言查看 */
export function PromptsPage() {
  const locale = useLocale();
  const prompts = usePrompts();
  const [viewing, setViewing] = useState<PromptItem | null>(null);
  const [tab, setTab] = useState<Locale>(locale);
  const purpose = (p: string) => t.aiUsage.purpose[p] ?? p;

  const open = (p: PromptItem) => {
    setTab(locale);
    setViewing(p);
  };

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.prompts.title}
        </Typography.Title>
        <Typography.Text type="secondary">{t.prompts.desc}</Typography.Text>
      </div>
      <TableFill>
        {(y) => (
          <Table<PromptItem>
            rowKey="key"
            bordered
            loading={prompts.isLoading}
            dataSource={prompts.data ?? []}
            pagination={false}
            scroll={{ x: 880, y }}
            locale={{ emptyText: <Empty description={t.prompts.empty} /> }}
            onRow={(p) => ({ onClick: () => open(p), style: { cursor: 'pointer' } })}
            columns={[
              {
                title: t.prompts.name,
                key: 'name',
                width: 220,
                render: (_, p) => (
                  <Flex vertical>
                    <Typography.Text>{pickText(p.title) ?? p.key}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      <code>{p.key}</code>
                    </Typography.Text>
                  </Flex>
                ),
              },
              {
                title: t.prompts.purpose,
                dataIndex: 'purpose',
                width: 140,
                render: (v: string) => <Tag style={{ marginInlineEnd: 0 }}>{purpose(v)}</Tag>,
              },
              {
                title: t.prompts.description,
                key: 'description',
                render: (_, p) => <Typography.Text style={{ fontSize: 13 }}>{pickText(p.description)}</Typography.Text>,
              },
              {
                title: t.prompts.vars,
                dataIndex: 'vars',
                width: 220,
                render: (vars: string[]) =>
                  vars.length ? (
                    <Flex gap={4} wrap>
                      {vars.map((v) => (
                        <Tag key={v} style={{ marginInlineEnd: 0, fontFamily: 'var(--ant-font-family-code, monospace)', fontSize: 12 }}>
                          {`{{${v}}}`}
                        </Tag>
                      ))}
                    </Flex>
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ),
              },
              {
                key: 'actions',
                width: 90,
                align: 'center',
                render: (_, p) => (
                  <Button
                    type="link"
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      open(p);
                    }}
                  >
                    {t.prompts.view}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </TableFill>

      <Drawer
        open={!!viewing}
        onClose={() => setViewing(null)}
        size={760}
        title={
          viewing && (
            <Space size={8} wrap>
              {pickText(viewing.title) ?? viewing.key}
              <Tag style={{ marginInlineEnd: 0 }}>{purpose(viewing.purpose)}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
                <LockOutlined /> {t.prompts.readonly}
              </Typography.Text>
            </Space>
          )
        }
      >
        {viewing && (
          <Flex vertical gap={12}>
            <Typography.Text type="secondary">{pickText(viewing.description)}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {viewing.vars.length ? t.prompts.varsHelp : t.prompts.noVars}
              {viewing.updatedAt && ` · ${t.prompts.updatedAt} ${fromNow(viewing.updatedAt)}`}
            </Typography.Text>
            <Tabs
              activeKey={tab}
              onChange={(k) => setTab(k as Locale)}
              items={LOCALES.filter((l) => viewing.text[l.value]).map((l) => ({
                key: l.value,
                label: l.label,
                children: (
                  <Flex vertical gap={8}>
                    <Typography.Paragraph copyable={{ text: viewing.text[l.value] }} style={{ margin: 0 }}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        <code>{viewing.key}</code> · {l.label}
                      </Typography.Text>
                    </Typography.Paragraph>
                    <PromptText text={viewing.text[l.value]!} />
                  </Flex>
                ),
              }))}
            />
          </Flex>
        )}
      </Drawer>
    </div>
  );
}
