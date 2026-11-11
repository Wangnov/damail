/** 「关于」页用到的项目信息 */

/** 开源仓库地址，例如 https://github.com/xxx/damail；留空时不显示 Star、源码和反馈按钮 */
export const REPO_URL: string = 'https://github.com/gopkg-dev/damail';

/** 官网和文档（website/，部署在 GitHub Pages）；英文界面链到英文文档 */
export const SITE_URL = 'https://damail.app';
export const docsUrl = (path: string, locale: string) => `${SITE_URL}/${locale === 'zh-CN' ? '' : 'en/'}docs/${path}`;

export const AUTHOR = {
  name: 'Karen',
  github: 'gopkg-dev',
  website: 'https://damail.app',
};

export const APP_VERSION = __APP_RELEASE__.version;

/** 仓库地址里的 owner/repo，用来查 Star 数；不是 GitHub 地址时返回 null */
export function githubRepo(url: string) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}
