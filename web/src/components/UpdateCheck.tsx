import { ArrowUpOutlined, GithubOutlined, SyncOutlined } from '@ant-design/icons';
import { App, Button, Typography } from 'antd';
import { useState } from 'react';
import { useCheckUpdates, useNewRelease, useUpdateStatus } from '../hooks/updates';
import { fromNow } from '../lib/format';
import { docsUrl } from '../lib/about';
import { RELEASE } from '../lib/release';
import { t, useLocale } from '../i18n';
import { Notes } from './Changelog';

const UPGRADE_CMD = 'docker compose pull && docker compose up -d';

/** 更新日志页顶部：有新版本时显示新版本的更新说明和升级命令，否则显示检查结果和「检查更新」按钮 */
export function UpdateCheck() {
  const locale = useLocale();
  const lang = locale === 'zh-CN' ? 'zh' : 'en';
  const { message } = App.useApp();
  const status = useUpdateStatus();
  const next = useNewRelease();
  const check = useCheckUpdates();
  const [checking, setChecking] = useState(false);

  const onCheck = async () => {
    setChecking(true);
    try {
      const s = await check();
      if (s.error) message.error(t.about.checkFailed(s.error));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  if (!status.data) return null;
  const s = status.data;
  if (!s.enabled) return <p className="update-status">{t.about.checkDisabled}</p>;

  const checkButton = (
    <Button size="small" type="text" icon={<SyncOutlined spin={checking} />} onClick={onCheck} disabled={checking}>
      {t.about.checkUpdates}
    </Button>
  );
  const checked = s.checkedAt ? t.about.checkedAt(fromNow(s.checkedAt)) : null;

  if (next) {
    return (
      <section className="update-card">
        <div className="changelog-head">
          <ArrowUpOutlined className="update-card-icon" />
          <span className="changelog-tag">{t.about.newVersionTitle(next.tag)}</span>
          {next.publishedAt && <span className="changelog-date">{next.publishedAt.slice(0, 10)}</span>}
          <span style={{ flex: 1 }} />
          <Button size="small" type="text" icon={<GithubOutlined />} href={next.url} target="_blank" rel="noopener noreferrer">
            {t.about.viewOnGithub}
          </Button>
        </div>
        {next.notes && <Notes notes={next.notes[lang]} />}
        <div className="update-how">
          <div>{t.about.upgradeHow}</div>
          <Typography.Paragraph code copyable className="update-cmd">
            {UPGRADE_CMD}
          </Typography.Paragraph>
          <div>
            {t.about.upgradeOther}{' '}
            <a href={docsUrl('upgrade/', locale)} target="_blank" rel="noopener noreferrer">
              {t.about.upgradeDocs}
            </a>
          </div>
        </div>
        <div className="update-status">
          {checked}
          {checkButton}
        </div>
      </section>
    );
  }

  // 没有新版本；没打过标签的开发版本比较不了，只说 GitHub 上最新的是哪个
  const latest = s.latest?.tag;
  const text = s.error ? t.about.checkFailed(s.error) : !latest ? t.about.noRemoteRelease : RELEASE.tag ? t.about.upToDate : t.about.latestIs(latest);
  return (
    <p className="update-status">
      {text}
      {checked && <span>· {checked}</span>}
      {checkButton}
    </p>
  );
}
