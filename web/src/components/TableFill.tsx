import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * 让表格撑满父级 flex 列剩余的高度，表头固定、表体内部滚动。
 * 父级需要是 display: flex; flex-direction: column，children 拿到的 y 直接传给 Table 的 scroll.y。
 * 先量出高度再渲染表格：不先渲染一遍没有 scroll.y 的完整表格（行多时很慢），也能配合 virtual 只渲染看得见的行。
 */
export function TableFill({ children }: { children: (y: number | undefined) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [y, setY] = useState<number>();

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 设了 scroll.y 之后表头会单独渲染成 .ant-table-header；表格还没渲染时先按 40px 估算，渲染后再校正
    const head = el.querySelector<HTMLElement>('.ant-table-header, .ant-table-thead');
    // 减去带边框表格上下各 1px 的边框
    setY(Math.max(120, Math.floor(el.clientHeight - (head?.offsetHeight ?? 40) - 2)));
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update]);

  // 表格第一次渲染出来后按实际表头高度校正（绘制前完成，看不到跳动）
  const ready = y !== undefined;
  useLayoutEffect(() => {
    if (ready) update();
  }, [ready, update]);

  return (
    <div ref={ref} className="table-fill" style={{ flex: 1, minHeight: 0, '--table-fill-y': y ? `${y}px` : undefined } as CSSProperties}>
      {ready && children(y)}
    </div>
  );
}
