import { App, Button } from 'antd';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useNewRelease } from '../hooks/updates';
import { t } from '../i18n';
import { RELEASE } from '../lib/release';

const SEEN_KEY = 'damail.seenRelease';
const NOTIFIED_KEY = 'damail.notifiedRelease';
export const CHANGELOG_PATH = '/settings/changelog';

/**
 * 两种提示，都在右上角（和其他通知一样，不挡右下角的助手），每台设备单独记：
 * - 部署了新版本（版本标签变了）后，第一次打开时提示一次「已更新到 vX」。只看标签：同一个标签之后多出来的提交不提示；
 *   第一次使用（本机还没记录）也不提示。
 * - GitHub 上发布了比当前更新的正式版本时，提示一次「有新版本 vX」。
 */
export function useUpdateNotice() {
  const { notification } = App.useApp();
  const navigate = useNavigate();
  const next = useNewRelease();

  const open = (key: string, title: string, description: string) =>
    notification.open({
      key,
      duration: 12,
      title,
      description,
      actions: (
        <Button
          type="primary"
          size="small"
          onClick={() => {
            notification.destroy(key);
            navigate(CHANGELOG_PATH);
          }}
        >
          {t.about.viewChanges}
        </Button>
      ),
    });

  useEffect(() => {
    const tag = RELEASE.tag;
    if (!tag) return;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(SEEN_KEY);
      localStorage.setItem(SEEN_KEY, tag);
    } catch {
      return;
    }
    if (!seen || seen === tag) return;
    open('damail-updated', t.about.updatedTitle(tag), t.about.updatedDesc);
  }, []);

  // GitHub 上有更新的正式版本：每个版本每台设备提示一次，之后只在设置图标和「更新日志」上挂红点
  useEffect(() => {
    if (!next) return;
    try {
      if (localStorage.getItem(NOTIFIED_KEY) === next.tag) return;
      localStorage.setItem(NOTIFIED_KEY, next.tag);
    } catch {
      return;
    }
    open('damail-new-release', t.about.newVersionTitle(next.tag), t.about.newVersionDesc);
  }, [next?.tag]);
}
