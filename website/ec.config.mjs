// 代码块（Expressive Code）配置：和首页一致的圆角，明暗各一套主题。
// 放在单独的文件里而不是 astro.config.mjs，内容缓存渲染 Markdown 时和页面才会用同一份配置，
// 否则缓存里的代码块会引用旧配置生成的样式文件（404）。
import { defineEcConfig } from '@astrojs/starlight/expressive-code';

export default defineEcConfig({
  themes: ['github-dark-default', 'github-light-default'],
  styleOverrides: {
    borderRadius: '14px',
    borderColor: 'var(--mh-line)',
    codeFontSize: '0.84rem',
    codeLineHeight: '1.7',
    codePaddingBlock: '1rem',
    codePaddingInline: '1.15rem',
    frames: { shadowColor: 'transparent', editorTabBarBackground: 'transparent', terminalTitlebarBackground: 'transparent' },
  },
});
