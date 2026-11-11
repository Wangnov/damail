import { Dropdown, type MenuProps } from 'antd';
import { useEffect } from 'react';

/**
 * 在鼠标位置弹出的右键菜单：受控的 Dropdown 挂在一个 1×1 的固定定位锚点上。
 * 点菜单项、点外面、按 Esc 都会关闭。
 */
export function ContextMenu({
  x,
  y,
  items,
  onClick,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuProps['items'];
  onClick: (key: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <Dropdown
      // 换位置右键时重新定位
      key={`${x},${y}`}
      open
      trigger={['contextMenu']}
      menu={{
        items,
        className: 'thread-ctx-menu',
        onClick: ({ key }) => {
          onClose();
          onClick(key);
        },
      }}
      onOpenChange={(open) => !open && onClose()}
      destroyOnHidden
    >
      <span style={{ position: 'fixed', left: x, top: y, width: 1, height: 1, pointerEvents: 'none' }} />
    </Dropdown>
  );
}
