import { useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import { saveLocale, type CurrentUser } from '../api';
import { getLocale, setLocale, t, type Locale } from '../i18n';

/**
 * 切换界面语言并保存到账号：先改缓存里账号的语言（不然重新挂载后会按旧的切回去），
 * 再切界面，最后保存到账号；保存失败只在这台设备上生效
 */
export function useChangeLocale() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  return (next: Locale) => {
    if (next === getLocale()) return;
    qc.setQueryData<{ needsSetup: boolean; user: CurrentUser | null }>(['auth'], (old) => (old?.user ? { ...old, user: { ...old.user, locale: next } } : old));
    setLocale(next);
    saveLocale(next).catch(() => message.warning(t.layout.localeSaveFailed));
  };
}
