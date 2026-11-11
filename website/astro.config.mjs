// DaMail 官网：首页是自己写的 src/pages（index.astro 中文、en/index.astro 英文），文档用 Starlight（src/content/docs）。
// 部署到 GitHub Pages，自定义域名 https://damail.app/（public/CNAME；见 .github/workflows/pages.yml）
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

const REPO = 'https://github.com/gopkg-dev/damail';

const group = (zh, en, items) => ({ label: zh, translations: { en }, items });

export default defineConfig({
  site: 'https://damail.app',
  trailingSlash: 'always',
  devToolbar: { enabled: false },
  integrations: [
    starlight({
      title: 'DaMail',
      description: '自托管的多邮箱聚合服务，通过 MCP 和 REST API 安全地交给 AI Agent 使用',
      logo: { src: './src/assets/logo.svg', alt: 'DaMail' },
      favicon: '/favicon.svg',
      defaultLocale: 'root',
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
        en: { label: 'English', lang: 'en' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/website/` },
      lastUpdated: true,
      customCss: ['./src/styles/docs.css'],
      sidebar: [
        group('开始', 'Getting started', [{ slug: 'docs' }, { slug: 'docs/quick-start' }, { slug: 'docs/configuration' }, { slug: 'docs/proxies' }, { slug: 'docs/upgrade' }]),
        group('使用', 'Using DaMail', [{ slug: 'docs/mailboxes' }, { slug: 'docs/mail' }, { slug: 'docs/subscriptions' }, { slug: 'docs/search' }]),
        group('AI 功能', 'AI features', [
          { slug: 'docs/ai/models' },
          { slug: 'docs/ai/analysis' },
          { slug: 'docs/ai/labels' },
          { slug: 'docs/ai/search' },
          { slug: 'docs/ai/assistant' },
          { slug: 'docs/ai/translate' },
          { slug: 'docs/ai/usage' },
        ]),
        group('自动化', 'Automation', [
          { slug: 'docs/automation/rules' },
          { slug: 'docs/automation/notifications' },
          { slug: 'docs/automation/reports' },
          { slug: 'docs/automation/follow-ups' },
        ]),
        group('接入 AI Agent', 'AI agents', [{ slug: 'docs/assistants' }, { slug: 'docs/mcp' }, { slug: 'docs/oauth' }, { slug: 'docs/rest-api' }]),
        group('参与开发', 'Contributing', [{ slug: 'docs/development' }, { slug: 'docs/releasing' }]),
      ],
    }),
  ],
});
