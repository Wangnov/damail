import {
  ApiOutlined,
  BugOutlined,
  GithubOutlined,
  GlobalOutlined,
  MailFilled,
  RobotOutlined,
  SafetyOutlined,
  StarFilled,
  SyncOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Avatar, Button, Flex, Tag } from 'antd';
import { Link } from 'react-router';
import { SettingsPage } from '../../components/SettingsPage';
import { useNewRelease } from '../../hooks/updates';
import { intlLocale, t } from '../../i18n';
import { APP_VERSION, AUTHOR, REPO_URL, githubRepo } from '../../lib/about';

const FEATURE_ICONS = [<SyncOutlined key="sync" />, <RobotOutlined key="ai" />, <ApiOutlined key="api" />, <SafetyOutlined key="safe" />];

const STACK = ['Hono', 'PostgreSQL', 'Drizzle ORM', 'React', 'Ant Design', 'TanStack Query', 'Tiptap', 'MCP'];

/** 仓库的 Star 数：只在填了 GitHub 仓库地址时查，查不到就只显示「Star」 */
function useStars() {
  const repo = githubRepo(REPO_URL);
  return useQuery({
    queryKey: ['github-stars', repo],
    queryFn: async () => {
      const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(String(res.status));
      return ((await res.json()) as { stargazers_count: number }).stargazers_count;
    },
    enabled: Boolean(repo),
    staleTime: 60 * 60_000,
    retry: false,
  });
}

/** 设置 · 关于：项目介绍、作者、版本，仓库地址填了以后显示 Star / 源码 / 反馈 */
export function AboutPage() {
  const stars = useStars();
  const newRelease = useNewRelease();
  const authorUrl = `https://github.com/${AUTHOR.github}`;

  return (
    <SettingsPage title={t.about.title} description={t.about.description}>
      <div className="about-page">
        <section className="about-hero">
          <span className="app-logo about-logo" aria-hidden>
            <MailFilled />
          </span>
          <div className="about-hero-text">
            <Flex align="center" gap={8} wrap>
              <span className="about-name">DaMail</span>
              <Tag style={{ marginInlineEnd: 0 }}>{t.about.version(APP_VERSION)}</Tag>
              {newRelease && (
                <Link to="/settings/changelog">
                  <Tag color="error" style={{ marginInlineEnd: 0 }}>
                    {t.about.newVersionTag(newRelease.tag)}
                  </Tag>
                </Link>
              )}
              <Link to="/settings/changelog" style={{ fontSize: 13 }}>
                {t.about.viewChangelog}
              </Link>
            </Flex>
            <p className="about-tagline">{t.about.tagline}</p>
            {REPO_URL && (
              <Flex gap={8} wrap style={{ marginTop: 12 }}>
                <Button type="primary" icon={<StarFilled />} href={REPO_URL} target="_blank" rel="noopener noreferrer">
                  {stars.data !== undefined ? t.about.starCount(stars.data.toLocaleString(intlLocale())) : t.about.star}
                </Button>
                <Button icon={<GithubOutlined />} href={REPO_URL} target="_blank" rel="noopener noreferrer">
                  {t.about.source}
                </Button>
                <Button icon={<BugOutlined />} href={`${REPO_URL.replace(/\/$/, '')}/issues`} target="_blank" rel="noopener noreferrer">
                  {t.about.feedback}
                </Button>
              </Flex>
            )}
          </div>
        </section>
        {REPO_URL && <div className="pref-hint">{t.about.starHint}</div>}

        <h3 className="about-section-title">{t.about.featuresTitle}</h3>
        <div className="about-features">
          {t.about.features.map((f, i) => (
            <div key={f.title} className="about-feature">
              <span className="about-feature-icon">{FEATURE_ICONS[i]}</span>
              <div>
                <div className="pref-title">{f.title}</div>
                <div className="pref-desc">{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <h3 className="about-section-title">{t.about.authorTitle}</h3>
        <div className="about-author">
          {/* 头像用 GitHub 的，加载不出来时显示名字首字母 */}
          <Avatar size={48} src={`${authorUrl}.png?size=96`} alt={AUTHOR.name}>
            {AUTHOR.name.slice(0, 1)}
          </Avatar>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="pref-title">{AUTHOR.name}</div>
            <div className="pref-desc">{t.about.authorRole}</div>
          </div>
          <Flex gap={4} wrap justify="flex-end">
            <Button type="text" icon={<GithubOutlined />} href={authorUrl} target="_blank" rel="noopener noreferrer" title={t.about.viewGithub}>
              {AUTHOR.github}
            </Button>
            <Button type="text" icon={<GlobalOutlined />} href={AUTHOR.website} target="_blank" rel="noopener noreferrer" title={t.about.website}>
              {AUTHOR.website.replace(/^https?:\/\//, '')}
            </Button>
          </Flex>
        </div>

        <h3 className="about-section-title">{t.about.stackTitle}</h3>
        <Flex gap={6} wrap>
          {STACK.map((s) => (
            <Tag key={s} style={{ marginInlineEnd: 0 }}>
              {s}
            </Tag>
          ))}
        </Flex>
        <p className="about-foot">{t.about.thanks}</p>
      </div>
    </SettingsPage>
  );
}
