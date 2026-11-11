import type { Rule } from 'antd/es/form';
import { Avatar, Checkbox, Flex, Segmented, Typography } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import type { AccountSummary } from '../api';
import { useAccounts } from '../hooks/data';
import { colorFor } from '../lib/format';
import { t } from '../i18n';

export type AccountScopeProps = {
  /** null / undefined 表示全部邮箱，数组表示指定邮箱（空数组 = 选了「指定」但还没勾，配合 accountScopeRule 拦下） */
  value?: number[] | null;
  onChange?: (value: number[] | null) => void;
  disabled?: boolean;
  /** 一行几列，默认 2；窄屏下自动变成一列 */
  columns?: number;
  /** 最多显示几行，超出后固定高度、内部滚动，默认 4 */
  maxRows?: number;
  /** 卡片右侧是否显示数量，默认不显示 */
  showCount?: boolean;
  /** 自定义右侧数量，不传时显示邮件总数 */
  count?: (account: AccountSummary) => ReactNode;
};

const fmt = (n: number) => n.toLocaleString('zh-CN');

/**
 * 邮箱范围选择：「全部邮箱 / 指定邮箱」切换，指定时用卡片勾选账户。
 * 可以直接放进 Form.Item 当受控组件用，搭配 accountScopeRule 校验。
 */
export function AccountScope({ value, onChange, disabled, columns = 2, maxRows = 4, showCount = false, count }: AccountScopeProps) {
  const accounts = useAccounts();
  const some = Array.isArray(value);
  const picked = value ?? [];

  return (
    <Flex vertical gap={12}>
      <Segmented<'all' | 'some'>
        value={some ? 'some' : 'all'}
        onChange={(v) => onChange?.(v === 'some' ? [] : null)}
        disabled={disabled}
        options={[
          { value: 'all', label: t.accounts.allAccounts },
          { value: 'some', label: t.accounts.someAccounts },
        ]}
        style={{ alignSelf: 'flex-start' }}
      />
      {some && (
        <Checkbox.Group value={picked} onChange={(v) => onChange?.(v as number[])} disabled={disabled} style={{ display: 'block' }}>
          <div className="account-scope" style={{ '--account-scope-columns': columns, '--account-scope-rows': maxRows } as CSSProperties}>
            {accounts.data?.map((a) => (
              <label key={a.id} className={`account-scope-item${picked.includes(a.id) ? ' is-checked' : ''}`}>
                <Checkbox value={a.id} />
                <Avatar size={24} style={{ background: a.color ?? colorFor(a.id), fontSize: 12, flex: 'none' }}>
                  {a.name.slice(0, 1).toUpperCase()}
                </Avatar>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <Typography.Text ellipsis style={{ display: 'block' }}>
                    {a.name}
                  </Typography.Text>
                  <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
                    {a.email}
                  </Typography.Text>
                </span>
                {showCount && (
                  <Typography.Text type="secondary" style={{ fontSize: 12, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
                    {count ? count(a) : fmt(a.messageCount)}
                  </Typography.Text>
                )}
              </label>
            ))}
          </div>
        </Checkbox.Group>
      )}
    </Flex>
  );
}

/**
 * 选了「指定邮箱」却一个都没勾时提示，不然保存后会变成全部邮箱。
 * 只在保存（validateFields）时检查，刚切到「指定邮箱」还没来得及勾时不报错；之后改动会清掉错误。
 */
export const accountScopeRule: Rule = {
  validateTrigger: 'onSubmit',
  validator: (_, v: unknown) => (Array.isArray(v) && !v.length ? Promise.reject(new Error(t.accounts.pickOne)) : Promise.resolve()),
};
