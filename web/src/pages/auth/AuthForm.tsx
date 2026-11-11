import {
  ArrowRightOutlined,
  CheckOutlined,
  DisconnectOutlined,
  ExclamationCircleFilled,
  LockOutlined,
  MailFilled,
  StopOutlined,
  UserOutlined,
  WarningFilled,
} from '@ant-design/icons';
import { Button, Form, Input, Segmented } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LOCALES, setLocale, t, useLocale, type Locale } from '../../i18n';
import { fmtLeft, type AuthMode, type AuthSubmit, type ErrorKind } from './useAuthSubmit';

/** 未登录时语言只存在本机；创建账号时会带上，登录后以账号保存的为准 */
export function LangSwitch({ className }: { className?: string }) {
  const locale = useLocale();
  return (
    <div className={className}>
      <Segmented<Locale>
        size="small"
        value={locale}
        onChange={setLocale}
        options={LOCALES.map((l) => ({ value: l.value, label: <span lang={l.value}>{l.short}</span>, title: l.label }))}
      />
    </div>
  );
}

export function LogoMark() {
  return (
    <span className="app-logo auth-logo-mark">
      <MailFilled />
    </span>
  );
}

const ERROR_ICON: Record<ErrorKind, ReactNode> = {
  wrong: <WarningFilled />,
  locked: <StopOutlined />,
  network: <DisconnectOutlined />,
  other: <ExclamationCircleFilled />,
};

/** 提交出错时表单上方的提示：图标 + 标题 + 说明，断网时带重试，锁定时显示倒计时 */
function AuthAlert({ auth, mode }: { auth: AuthSubmit; mode: AuthMode }) {
  const e = auth.error;
  if (!e) return null;
  const err = t.auth.errors;
  const title =
    e.kind === 'wrong'
      ? err.wrongTitle
      : e.kind === 'locked'
        ? err.lockedTitle
        : e.kind === 'network'
          ? err.networkTitle
          : mode === 'setup'
            ? err.setupTitle
            : err.otherTitle;
  const desc = e.kind === 'wrong' ? err.wrongDesc : e.kind === 'locked' ? err.lockedDesc : e.kind === 'network' ? err.networkDesc : e.message;
  return (
    // key 让同一种错误再次出现时也重新播放进场动画
    <div key={e.at} className={`auth-alert auth-alert-${e.kind}`} role="alert" aria-live="assertive">
      <span className="auth-alert-icon">{ERROR_ICON[e.kind]}</span>
      <div className="auth-alert-body">
        <b>{title}</b>
        <span>{desc}</span>
      </div>
      {e.kind === 'network' && (
        <Button size="small" onClick={auth.retry} loading={auth.phase === 'loading'}>
          {err.retry}
        </Button>
      )}
      {e.kind === 'locked' && auth.lockLeft > 0 && <span className="auth-alert-timer">{fmtLeft(auth.lockLeft)}</span>}
    </div>
  );
}

type Props = {
  auth: AuthSubmit;
  mode: AuthMode;
  /** 标题上方的 Logo（窄屏左侧介绍隐藏时显示） */
  logo?: ReactNode;
};

/** 登录表单：标题、错误提示、用户名密码、提交按钮和加载进度条 */
export function AuthForm({ auth, mode, logo }: Props) {
  const setup = mode === 'setup';
  const shakeRef = useRef<HTMLDivElement>(null);
  const [caps, setCaps] = useState(false);

  // 出错时整个表单左右晃一下（系统要求减少动态效果时不晃）
  useEffect(() => {
    if (!auth.error || auth.error.kind === 'network') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    shakeRef.current?.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-10px)' },
        { transform: 'translateX(8px)' },
        { transform: 'translateX(-5px)' },
        { transform: 'translateX(3px)' },
        { transform: 'translateX(0)' },
      ],
      { duration: 420, easing: 'ease-out' },
    );
  }, [auth.error]);

  const wrong = auth.phase === 'error' && auth.error?.kind === 'wrong';
  const locked = auth.lockLeft > 0;
  const label =
    auth.phase === 'loading'
      ? setup
        ? t.auth.creating
        : t.auth.signingIn
      : auth.phase === 'success'
        ? setup
          ? t.auth.created
          : t.auth.signedIn
        : setup
          ? t.auth.createAndEnter
          : t.auth.login;

  return (
    <div ref={shakeRef} className="auth-form auth-enter-form" data-phase={auth.phase}>
      {logo}
      <h2 className="auth-title">{setup ? t.auth.setupTitle : t.auth.welcome}</h2>
      <p className="auth-subtitle">{setup ? t.auth.setupHint : t.auth.welcomeSub}</p>

      <AuthAlert auth={auth} mode={mode} />

      <Form form={auth.form} layout="vertical" onFinish={auth.submit} onValuesChange={auth.onEdit} requiredMark={false} size="large" disabled={auth.busy}>
        <Form.Item
          name="username"
          label={t.auth.username}
          rules={[{ required: true, message: t.auth.usernameRequired }]}
          validateStatus={wrong ? 'error' : undefined}
        >
          <Input variant="underlined" prefix={<UserOutlined />} placeholder={t.auth.usernamePlaceholder} autoComplete="username" autoFocus />
        </Form.Item>
        <Form.Item
          name="password"
          label={t.auth.password}
          rules={[{ required: true, message: t.auth.passwordRequired }, ...(setup ? [{ min: 8, message: t.auth.passwordMin }] : [])]}
          validateStatus={wrong ? 'error' : undefined}
          extra={
            caps ? (
              <span className="auth-caps">
                <WarningFilled /> {t.auth.capsLock}
              </span>
            ) : undefined
          }
        >
          <Input.Password
            variant="underlined"
            prefix={<LockOutlined />}
            placeholder={setup ? t.auth.setupPasswordPlaceholder : t.auth.passwordPlaceholder}
            autoComplete={setup ? 'new-password' : 'current-password'}
            onKeyDown={(e) => setCaps(e.getModifierState('CapsLock'))}
            onKeyUp={(e) => setCaps(e.getModifierState('CapsLock'))}
            onBlur={() => setCaps(false)}
          />
        </Form.Item>
        <Button
          type="primary"
          htmlType="submit"
          block
          // 加载和成功时表单整体禁用，按钮自己保持可见的样式
          disabled={locked}
          loading={auth.phase === 'loading'}
          color={auth.phase === 'success' ? 'green' : 'primary'}
          variant="solid"
          icon={auth.phase === 'success' ? <CheckOutlined className="auth-check" /> : undefined}
          className={`auth-submit ${auth.phase === 'success' ? 'is-success' : ''}`}
        >
          {label}
          {auth.phase !== 'loading' && auth.phase !== 'success' && <ArrowRightOutlined className="auth-arrow" />}
        </Button>
        <div className={`auth-progress ${auth.phase === 'loading' ? 'on' : ''}`} aria-hidden="true" />
        {auth.phase === 'success' && <p className="auth-entering">{t.auth.entering}</p>}
      </Form>
    </div>
  );
}
