import { Button, Card, Flex, Result, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { OAuthProvider } from '../api';
import { OAUTH_META, useOAuthChannel, type OAuthResult } from './settings/OAuth';
import { t } from '../i18n';

const CLOSE_AFTER = 5;

/**
 * OAuth 回调的落地页，在授权时打开的新标签页里显示，不需要登录（会话过期的错误也要能看到）。
 * 结果传回发起授权的页面；成功且对方收到后倒计时关闭，失败时留着看原因
 */
export function OAuthResultPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const provider = params.get('provider') as OAuthProvider | null;
  const meta = provider ? OAUTH_META[provider] : undefined;
  const result: OAuthResult =
    params.get('oauth') === 'ok' ? { ok: true, email: params.get('email') } : { ok: false, error: params.get('oauth_error') || t.oauthApps.notCompleted };

  const [delivered, setDelivered] = useState(false);
  const [left, setLeft] = useState(CLOSE_AFTER);
  const [closeFailed, setCloseFailed] = useState(false);
  const post = useOAuthChannel({ onAck: () => setDelivered(true) });

  // 开发模式下 effect 会执行两次，只发一次
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    post(result);
  });

  const close = () => {
    window.close();
    // 不是脚本打开的标签页关不掉，提示手动关
    window.setTimeout(() => setCloseFailed(true), 300);
  };

  const counting = result.ok && delivered && !closeFailed;
  useEffect(() => {
    if (!counting) return;
    if (left <= 0) return close();
    const timer = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [counting, left]);

  const hint = closeFailed ? t.oauthApps.canClose : counting ? t.oauthApps.closingIn(left) : result.ok ? t.oauthApps.backToSee : t.oauthApps.retry;

  return (
    <Flex align="center" justify="center" style={{ minHeight: '100%', padding: 16, boxSizing: 'border-box' }}>
      <Card style={{ width: 460, maxWidth: '100%' }}>
        <Result
          status={result.ok ? 'success' : 'error'}
          title={result.ok ? t.oauthApps.success : t.oauthApps.failed}
          subTitle={
            result.ok ? (
              <>
                {meta ? `${meta.account} ` : ''}
                <Typography.Text strong>{result.email ?? t.oauthApps.mailbox}</Typography.Text>
                {t.oauthApps.connectedSyncing}
              </>
            ) : (
              result.error
            )
          }
          extra={
            <Flex vertical align="center" gap={16}>
              <Flex gap={8} justify="center" wrap>
                <Button type={result.ok ? 'primary' : 'default'} onClick={close}>
                  {t.oauthApps.closePage}
                </Button>
                <Button type={result.ok ? 'default' : 'primary'} onClick={() => navigate('/settings/accounts', { replace: true })}>
                  {t.oauthApps.goAccounts}
                </Button>
              </Flex>
              <Typography.Text type="secondary">{hint}</Typography.Text>
            </Flex>
          }
        />
      </Card>
    </Flex>
  );
}
