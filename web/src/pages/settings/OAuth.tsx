import { GoogleOutlined, WindowsFilled } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import { api, type Account, type OAuthConfig, type OAuthProvider } from '../../api';
import { t } from '../../i18n';

type Meta = {
  /** 服务商账号名，用在按钮和提示里 */
  account: string;
  desc: string;
  icon: ReactNode;
  brand: string;
  /** 应用注册后台 */
  consoleName: string;
  consoleUrl: string;
  steps: (redirect: ReactNode) => ReactNode[];
  clientIdLabel: string;
  /** 客户端 ID 在服务商后台叫什么、在哪里 */
  clientIdHint?: string;
  clientIdPlaceholder: string;
  intro: string;
  warning?: string;
};

type Base = Pick<Meta, 'icon' | 'brand' | 'consoleName' | 'consoleUrl' | 'clientIdPlaceholder'>;

/** 文字部分是 getter，按当前界面语言取；步骤里的 {redirect} 换成回调地址 */
function localized(provider: OAuthProvider, base: Base): Meta {
  const text = () => t.oauthApps[provider];
  return {
    ...base,
    get account() {
      return text().account;
    },
    get desc() {
      return text().desc;
    },
    get intro() {
      return text().intro;
    },
    get clientIdLabel() {
      return text().clientIdLabel;
    },
    get clientIdHint() {
      return text().clientIdHint;
    },
    get warning() {
      return text().warning;
    },
    steps: (redirect) =>
      text().steps.map((s) => {
        const [before, after] = s.split('{redirect}');
        return after === undefined ? (
          s
        ) : (
          <>
            {before}
            {redirect}
            {after}
          </>
        );
      }),
  };
}

export const OAUTH_META: Record<OAuthProvider, Meta> = {
  microsoft: localized('microsoft', {
    icon: <WindowsFilled />,
    brand: '#0078d4',
    consoleName: 'Microsoft Entra',
    consoleUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    clientIdPlaceholder: '00000000-0000-0000-0000-000000000000',
  }),
  google: localized('google', {
    icon: <GoogleOutlined />,
    brand: '#4285f4',
    consoleName: 'Google Cloud',
    consoleUrl: 'https://console.cloud.google.com/auth/clients',
    clientIdPlaceholder: '1234567890-xxxx.apps.googleusercontent.com',
  }),
};

export const OAUTH_PROVIDERS = Object.keys(OAUTH_META) as OAuthProvider[];

/** 已有 OAuth 账户用的是哪家 */
export const oauthProviderOf = (account: Pick<Account, 'provider'>): OAuthProvider => (account.provider === 'gmail' ? 'google' : 'microsoft');

export function useOAuthConfig(provider: OAuthProvider, enabled = true) {
  return useQuery({ queryKey: ['oauth', provider], queryFn: () => api<OAuthConfig>(`/api/admin/oauth/${provider}`), enabled });
}

/** 在新标签页打开服务商登录页，原页面不动；accountId 表示给已有账户重新授权 */
export function startOAuth(provider: OAuthProvider, accountId?: number) {
  window.open(`/api/oauth/${provider}/start${accountId ? `?account=${accountId}` : ''}`, '_blank', 'noopener');
}

export type OAuthResult = { ok: true; email: string | null } | { ok: false; error: string };
type OAuthMessage = { type: 'result'; result: OAuthResult } | { type: 'ack' };

// 整个页面共用一个频道，不随组件关掉重开：开发模式下 effect 执行两次，频道重开的间隙会漏掉对方回的 ack
let channel: BroadcastChannel | null | undefined;
const oauthChannel = () => (channel ??= typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('damail.oauth'));

/**
 * 授权回调落在新标签页的结果页，结果经 BroadcastChannel 传回发起授权的页面；那边收到后回一个 ack，结果页再自己关掉。
 * 同一个频道对象发出的消息自己收不到；不传 onResult 的（结果页）只发不收，也不回 ack
 */
export function useOAuthChannel(handlers: { onResult?: (r: OAuthResult) => void; onAck?: () => void }) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const ch = oauthChannel();
    if (!ch) return;
    const onMessage = (e: MessageEvent<OAuthMessage>) => {
      if (e.data.type === 'ack') return ref.current.onAck?.();
      if (!ref.current.onResult) return;
      ch.postMessage({ type: 'ack' } satisfies OAuthMessage);
      ref.current.onResult(e.data.result);
    };
    ch.addEventListener('message', onMessage);
    return () => ch.removeEventListener('message', onMessage);
  }, []);
  return (result: OAuthResult) => oauthChannel()?.postMessage({ type: 'result', result } satisfies OAuthMessage);
}
