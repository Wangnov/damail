import { Flex } from 'antd';
import type { ReactNode } from 'react';

/** 表格里的一组标签：换行时上下左右都留出间距 */
export function TagList({ children }: { children: ReactNode }) {
  return (
    <Flex wrap gap={6}>
      {children}
    </Flex>
  );
}
