import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { XProvider } from '@ant-design/x';
import enUSX from '@ant-design/x/locale/en_US';
import zhCNX from '@ant-design/x/locale/zh_CN';
import { App as AntApp, theme } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { useLocale } from './i18n';
import { BORDER_TOKENS, RADIUS, useAccent, useBorder, useComponentSize, useDarkMode, useMotion, useRadius } from './lib/theme';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 } },
});

function Root() {
  const dark = useDarkMode();
  const accent = useAccent();
  const componentSize = useComponentSize();
  const r = RADIUS[useRadius()].scale;
  const border = BORDER_TOKENS[dark ? 'dark' : 'light'][useBorder()];
  const locale = useLocale();
  const motion = useMotion();
  return (
    // XProvider 是 antd ConfigProvider 的扩展，额外带上 Ant Design X 组件的文案（如「停止请求」）
    <XProvider
      locale={locale === 'zh-CN' ? { ...zhCN, ...zhCNX } : { ...enUS, ...enUSX }}
      // 标签统一带边框（antd 6 默认是无边框的 filled），成组的标签由外层 Flex / Space 留间距
      tag={{ variant: 'outlined' }}
      componentSize={componentSize}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        // motion 关掉 antd 组件自己的动画（弹窗、下拉、波纹等），样式表里的过渡按 <html data-motion> 关
        token: { colorPrimary: accent, borderRadius: Math.round(6 * r), motion, ...border },
        components: {
          // 分段控制器和左侧菜单同一套配色：浅灰底槽，选中项白底（深色下浅一档的灰）+ 细阴影
          Segmented: {
            trackBg: 'var(--mh-nav-hover)',
            trackPadding: 3,
            itemColor: 'var(--mh-nav-text)',
            itemHoverColor: 'var(--mh-nav-text-strong)',
            itemHoverBg: 'var(--mh-nav-hover)',
            itemActiveBg: 'var(--mh-nav-hover)',
            itemSelectedBg: 'var(--mh-nav-active)',
            itemSelectedColor: 'var(--mh-nav-text-strong)',
            borderRadius: Math.round(9 * r),
            borderRadiusSM: Math.round(7 * r),
            borderRadiusXS: Math.round(6 * r),
          },
          // 分页和分段控制器一个样子（见 styles.css「分页」）：页码放在浅灰底槽里，这里只把默认的底色、边框去掉，尺寸和底槽对齐
          Pagination: {
            itemSizeSM: 30,
            itemBg: 'transparent',
            itemActiveBg: 'transparent',
            itemLinkBg: 'transparent',
          },
          // 表格统一带边框，行高收紧一点，表头用次要文字色
          Table: {
            cellPaddingBlock: 12,
            cellPaddingBlockMD: 10,
            headerColor: dark ? 'rgba(255, 255, 255, 0.65)' : 'rgba(0, 0, 0, 0.65)',
            headerSplitColor: 'transparent',
          },
        },
      }}
    >
      <AntApp style={{ height: '100%' }}>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            {/* 切换语言时整个界面重新挂载，各处文案（包括模块里按语言生成的选项）都换成新语言；查询缓存保留 */}
            <App key={locale} />
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </XProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
