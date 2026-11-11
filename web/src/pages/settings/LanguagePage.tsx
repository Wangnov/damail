import { CheckOutlined } from '@ant-design/icons';
import { SettingsPage } from '../../components/SettingsPage';
import { useChangeLocale } from '../../hooks/locale';
import { LOCALES, t, useLocale } from '../../i18n';

/** 基础设置 · 语言：界面、服务端提示、AI 输出和 MCP 工具说明都跟随，保存在账号里 */
export function LanguagePage() {
  const locale = useLocale();
  const changeLocale = useChangeLocale();
  return (
    <SettingsPage title={t.languagePage.title} description={t.languagePage.description}>
      <div className="language-options" role="radiogroup" aria-label={t.languagePage.title}>
        {LOCALES.map((l) => {
          const on = l.value === locale;
          return (
            <button
              key={l.value}
              type="button"
              role="radio"
              aria-checked={on}
              lang={l.value}
              className={`gen-kind${on ? ' on' : ''}`}
              onClick={() => changeLocale(l.value)}
            >
              <span>
                <span className="pref-title">{l.label}</span>
                <span className="pref-desc">{t.languagePage.hints[l.value]}</span>
              </span>
              {on && <CheckOutlined className="language-check" />}
            </button>
          );
        })}
      </div>
      <div className="pref-hint" style={{ marginTop: 16, maxWidth: 560 }}>
        {t.languagePage.scope}
      </div>
    </SettingsPage>
  );
}
