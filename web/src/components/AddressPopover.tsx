import { InboxOutlined, SendOutlined } from '@ant-design/icons';
import { Button, Flex, Popover, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { SenderAvatar } from './SenderAvatar';
import { t } from '../i18n';

const searchUrl = (q: string) => `/mail?view=all&q=${encodeURIComponent(q)}`;

/**
 * 邮件里的地址（发件人、收件人）：悬停显示联系人卡片，可以复制地址、查看和 TA 的往来邮件；
 * 直接点击等于「TA 发来的邮件」。点击不会冒泡到外层（外层点击会折叠邮件）。
 */
export function AddressPopover({ address, name, children }: { address?: string | null; name?: string | null; children: ReactNode }) {
  const navigate = useNavigate();
  if (!address) return <>{children}</>;
  const go = (q: string) => navigate(searchUrl(q));
  const content = (
    <div className="address-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
      <Flex gap={10} align="center" style={{ padding: '2px 4px 10px' }}>
        <SenderAvatar address={address} name={name || address} size={36} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Typography.Text strong ellipsis style={{ display: 'block' }}>
            {name || address.split('@')[0]}
          </Typography.Text>
          {/* 地址和复制按钮在同一行：地址太长时省略，复制按钮始终跟在地址后面 */}
          <Flex align="center" gap={4} style={{ minWidth: 0 }}>
            <Typography.Text type="secondary" ellipsis={{ tooltip: address }} style={{ fontSize: 12, minWidth: 0 }}>
              {address}
            </Typography.Text>
            <Typography.Text copyable={{ text: address, tooltips: [t.editor.copyAddress, t.editor.copied] }} style={{ fontSize: 12, flex: 'none' }} />
          </Flex>
        </div>
      </Flex>
      <Button type="text" block icon={<InboxOutlined />} onClick={() => go(`from:${address}`)}>
        {t.editor.fromThem}
      </Button>
      <Button type="text" block icon={<SendOutlined />} onClick={() => go(`to:${address}`)}>
        {t.editor.toThem}
      </Button>
    </div>
  );
  return (
    <Popover content={content} placement="bottomLeft" arrow={false} mouseEnterDelay={0.35}>
      <span
        className="address-link"
        role="link"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          go(`from:${address}`);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go(`from:${address}`);
        }}
      >
        {children}
      </span>
    </Popover>
  );
}

/** 邮件所在的邮箱和文件夹：点击打开这个邮箱的全部邮件 / 这个文件夹 */
export function PlaceLink({ to, title, children }: { to: string | null; title: string; children: ReactNode }) {
  const navigate = useNavigate();
  if (!to) return <>{children}</>;
  return (
    <span
      className="address-link"
      role="link"
      tabIndex={0}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        navigate(to);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(to);
      }}
    >
      {children}
    </span>
  );
}
