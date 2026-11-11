import { Empty, Flex } from 'antd';
import type { CSSProperties, ReactNode } from 'react';

/**
 * 没有数据时的占位：在所在容器里上下左右居中。
 * 容器有确定高度（卡片、可滚动列表）时撑满它；内容自适应高度时用 minHeight 留出空间。
 */
export function EmptyBlock({
  description,
  children,
  minHeight = 160,
  style,
}: {
  description: ReactNode;
  children?: ReactNode;
  minHeight?: number;
  style?: CSSProperties;
}) {
  return (
    <Flex align="center" justify="center" style={{ height: '100%', minHeight, ...style }}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description} style={{ margin: 0 }}>
        {children}
      </Empty>
    </Flex>
  );
}
