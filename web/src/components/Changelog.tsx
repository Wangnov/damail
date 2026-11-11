import { Button, Tag, Timeline } from 'antd';
import { useState } from 'react';
import { t, useLocale } from '../i18n';
import { RELEASE, type ReleaseCommit, type ReleaseNotes } from '../lib/release';

// 默认显示最近几个版本，更早的点开再看
const RECENT = 3;
// 没写更新说明时直接列提交，太多时先显示前几条
const COMMITS_PREVIEW = 8;

function Commits({ commits, preview }: { commits: ReleaseCommit[]; preview?: boolean }) {
  const [all, setAll] = useState(false);
  const shown = preview && !all ? commits.slice(0, COMMITS_PREVIEW) : commits;
  return (
    <>
      <ul className="changelog-commits">
        {shown.map((c) => (
          <li key={c.sha}>
            <span>{c.subject}</span>
            <code>{c.sha}</code>
          </li>
        ))}
      </ul>
      {shown.length < commits.length && (
        <Button type="link" size="small" className="changelog-toggle" onClick={() => setAll(true)}>
          {t.about.moreCommits(commits.length - shown.length)}
        </Button>
      )}
    </>
  );
}

export function Notes({ notes }: { notes: ReleaseNotes }) {
  return (
    <>
      {notes.intro.map((p) => (
        <p key={p} className="changelog-intro">
          {p}
        </p>
      ))}
      {notes.sections.map((s, i) => (
        <div key={`${s.title}-${i}`} className="changelog-section">
          {s.title && <div className="changelog-section-title">{s.title}</div>}
          <ul>
            {s.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** 有更新说明时提交记录默认收起 */
function FoldedCommits({ commits }: { commits: ReleaseCommit[] }) {
  const [open, setOpen] = useState(false);
  if (!commits.length) return null;
  return (
    <>
      <Button type="link" size="small" className="changelog-toggle" onClick={() => setOpen(!open)}>
        {open ? t.about.hideCommits : t.about.showCommits(commits.length)}
      </Button>
      {open && <Commits commits={commits} />}
    </>
  );
}

function Head({ title, date, current }: { title: string; date?: string; current?: boolean }) {
  return (
    <div className="changelog-head">
      <span className="changelog-tag">{title}</span>
      {date && <span className="changelog-date">{date}</span>}
      {current && (
        <Tag color="processing" style={{ marginInlineEnd: 0 }}>
          {t.about.current}
        </Tag>
      )}
    </div>
  );
}

/** 更新日志：版本号是 git 标签，内容是标签附注；没写附注的版本列出提交记录 */
export function Changelog() {
  const lang = useLocale() === 'zh-CN' ? 'zh' : 'en';
  const [showAll, setShowAll] = useState(false);
  const releases = showAll ? RELEASE.releases : RELEASE.releases.slice(0, RECENT);

  const items = [
    ...(RELEASE.unreleased.length
      ? [
          {
            color: 'gray',
            content: (
              <>
                <Head title={t.about.unreleased(RELEASE.tag)} />
                <Commits commits={RELEASE.unreleased} preview />
              </>
            ),
          },
        ]
      : []),
    ...releases.map((r) => {
      // 版本号正好是这个标签，或者是这个标签之后的开发版本
      const current = r.tag === RELEASE.tag;
      return {
        color: current ? 'blue' : 'gray',
        content: (
          <>
            <Head title={r.tag} date={r.date} current={current && !RELEASE.unreleased.length} />
            {r.notes ? (
              <>
                <Notes notes={r.notes[lang]} />
                <FoldedCommits commits={r.commits} />
              </>
            ) : (
              <Commits commits={r.commits} preview />
            )}
          </>
        ),
      };
    }),
  ];

  if (!items.length) return <p className="changelog-empty">{t.about.noReleases}</p>;
  return (
    <div className="changelog">
      <Timeline items={items} />
      {!showAll && RELEASE.releases.length > RECENT && (
        <Button size="small" onClick={() => setShowAll(true)}>
          {t.about.earlier(RELEASE.releases.length - RECENT)}
        </Button>
      )}
    </div>
  );
}
