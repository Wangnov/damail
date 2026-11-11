import { Changelog } from '../../components/Changelog';
import { SettingsPage } from '../../components/SettingsPage';
import { UpdateCheck } from '../../components/UpdateCheck';
import { t } from '../../i18n';

/** 设置 · 关于 · 更新日志 */
export function ChangelogPage() {
  return (
    <SettingsPage title={t.about.changelogTitle} description={t.about.changelogDesc}>
      <UpdateCheck />
      <Changelog />
    </SettingsPage>
  );
}
