import { Flex, Pagination } from 'antd';

/** 全站统一的每页条数 */
export const PAGE_SIZES = [20, 50, 100];
export const DEFAULT_PAGE_SIZE = 20;

/**
 * 表格下方的分页：右对齐，每页 20 / 50 / 100 条（默认 20），条数选择框不带搜索。
 * 改了每页条数时回到第 1 页。样式见 styles.css「分页」。
 */
export function Paging({
  page,
  pageSize,
  total,
  onChange,
  totalText,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number, pageSize: number) => void;
  totalText?: (n: number) => string;
}) {
  if (!total) return null;
  return (
    <Flex justify="flex-end" style={{ marginTop: 12, flex: 'none' }}>
      <Pagination
        size="small"
        current={page}
        pageSize={pageSize}
        total={total}
        showSizeChanger={{ showSearch: false }}
        pageSizeOptions={PAGE_SIZES}
        showTotal={totalText}
        onChange={(p, s) => onChange(s === pageSize ? p : 1, s)}
      />
    </Flex>
  );
}
