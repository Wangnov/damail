import { useState } from 'react';
import { colorFor, initials } from '../lib/format';

// 已经知道有 / 没有图标的域名：列表滚动时行会重新挂载，不用再闪一次首字母
const loaded = new Set<string>();
const missing = new Set<string>();

type Props = {
  address: string | null;
  name: string;
  size?: number;
  /** 指定取图标的域名（例如邮箱服务商），默认取邮箱地址的域名 */
  iconDomain?: string | null;
  /** 没有图标时的底色和文字，默认按地址和名字生成 */
  color?: string;
  text?: string;
};

/** 发件人头像：先显示名字首字母，品牌图标加载成功后换成图标，没有图标就保持首字母 */
export function SenderAvatar({ address, name, size = 36, iconDomain, color, text }: Props) {
  const domain = iconDomain ?? (address?.split('@')[1]?.trim().toLowerCase() || null);
  const [, rerender] = useState(0);
  const tryIcon = !!domain && !missing.has(domain);
  const showIcon = tryIcon && loaded.has(domain);

  return (
    <span
      className={`sender-avatar${showIcon ? ' has-icon' : ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: showIcon ? undefined : (color ?? colorFor(address ?? name)) }}
      aria-hidden
    >
      {!showIcon && (text ?? initials(name))}
      {tryIcon && (
        <img
          src={`/api/admin/icons/${encodeURIComponent(domain)}`}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          style={{ opacity: showIcon ? 1 : 0 }}
          onLoad={() => {
            // 同域名的几行可能同时在加载，每行都要自己刷新
            loaded.add(domain);
            rerender((n) => n + 1);
          }}
          onError={() => {
            missing.add(domain);
            rerender((n) => n + 1);
          }}
        />
      )}
    </span>
  );
}
