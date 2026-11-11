import { Flex, Typography } from 'antd';
import type { ReactNode } from 'react';

/**
 * 设置类页面的外壳：标题 + 说明 + 右上角操作固定在顶部，只有下面的内容区滚动。
 * fill：内容区改为 flex 列、自身不滚动，交给里面的 TableFill 撑满剩余高度（表头固定、表体滚动）
 */
export function SettingsPage({
  title,
  description,
  extra,
  fill,
  children,
}: {
  title: string;
  description?: ReactNode;
  extra?: ReactNode;
  fill?: boolean;
  children: ReactNode;
}) {
  return (
    <Flex vertical style={{ height: '100%', minHeight: 0 }}>
      <Flex align="center" justify="space-between" gap={16} style={{ flex: 'none', padding: '24px 24px 16px' }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          {description && <Typography.Text type="secondary">{description}</Typography.Text>}
        </div>
        {extra}
      </Flex>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: '0 24px 24px',
          ...(fill ? { display: 'flex', flexDirection: 'column', overflow: 'hidden' } : { overflow: 'auto' }),
        }}
      >
        {children}
      </div>
    </Flex>
  );
}
