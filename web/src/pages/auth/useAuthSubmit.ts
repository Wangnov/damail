import { useQueryClient } from '@tanstack/react-query';
import { Form } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { getLocale } from '../../i18n';

export type AuthMode = 'setup' | 'login';
export type Phase = 'idle' | 'loading' | 'success' | 'error';
export type ErrorKind = 'wrong' | 'locked' | 'network' | 'other';
export type AuthError = { kind: ErrorKind; message: string; at: number };
export type Credentials = { username: string; password: string };

// 服务端：每个 IP 10 分钟内失败 10 次就锁定 10 分钟，这里按同样的时长倒计时
const LOCK_MS = 10 * 60_000;
// 请求太快时转圈一闪而过，至少停留这么久，状态变化看得清
const MIN_LOADING_MS = 600;
// 成功后停一下再进入，让成功动画放完
const SUCCESS_HOLD_MS = 900;

const wait = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function classify(e: unknown): ErrorKind {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'wrong';
    if (e.status === 429) return 'locked';
    if (e.status >= 502 && e.status <= 504) return 'network';
    return 'other';
  }
  // fetch 本身失败（断网、服务没启动）是 TypeError
  return 'network';
}

/** 登录 / 初始化表单的提交流程：加载、成功、各类错误和锁定倒计时 */
export function useAuthSubmit(mode: AuthMode) {
  const qc = useQueryClient();
  const [form] = Form.useForm<Credentials>();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<AuthError | null>(null);
  const [lockUntil, setLockUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const lastValues = useRef<Credentials | null>(null);

  // 锁定期间每秒刷新倒计时，到点自动解除
  useEffect(() => {
    if (!lockUntil) return;
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= lockUntil) {
        setLockUntil(0);
        setError((e) => (e?.kind === 'locked' ? null : e));
        setPhase((p) => (p === 'error' ? 'idle' : p));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [lockUntil]);

  const lockLeft = lockUntil ? Math.max(0, lockUntil - now) : 0;

  const fail = (kind: ErrorKind, message: string) => {
    setError({ kind, message, at: Date.now() });
    setPhase('error');
    if (kind === 'locked') {
      setLockUntil(Date.now() + LOCK_MS);
      setNow(Date.now());
    }
    if (kind === 'wrong') {
      form.setFieldValue('password', '');
      // 等表单重新可用后再聚焦
      setTimeout(() => form.getFieldInstance('password')?.focus?.(), 0);
    }
  };

  const submit = async (values: Credentials) => {
    if (phase === 'loading' || phase === 'success' || lockLeft > 0) return;
    lastValues.current = values;
    setPhase('loading');
    setError(null);
    const started = Date.now();
    try {
      await api(mode === 'setup' ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        body: mode === 'setup' ? { ...values, locale: getLocale() } : values,
      });
      await wait(MIN_LOADING_MS - (Date.now() - started));
      setPhase('success');
      await wait(SUCCESS_HOLD_MS);
      await qc.invalidateQueries({ queryKey: ['auth'] });
    } catch (e) {
      await wait(MIN_LOADING_MS - (Date.now() - started));
      fail(classify(e), (e as Error).message);
      // 初始化时别人已经建好了账号，刷新一下切到登录
      if (e instanceof ApiError && e.status === 409) void qc.invalidateQueries({ queryKey: ['auth'] });
    }
  };

  const retry = () => {
    if (lastValues.current) void submit(lastValues.current);
    else form.submit();
  };

  /** 用户改了输入就把「密码错误」的红框去掉 */
  const onEdit = () => {
    if (phase === 'error' && error?.kind === 'wrong') setPhase('idle');
  };

  return { form, phase, error, lockLeft, submit, retry, onEdit, busy: phase === 'loading' || phase === 'success' };
}

export type AuthSubmit = ReturnType<typeof useAuthSubmit>;

/** 剩余锁定时间，例如 9:58 */
export const fmtLeft = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
