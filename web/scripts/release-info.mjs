/**
 * 版本号和更新日志，构建时注入前端（vite.config.ts 的 __APP_RELEASE__）。
 *
 * - 版本号取 git 标签：正好在标签上是「v0.2.0」，标签之后还有提交是「v0.2.0+3」，没有标签时是提交号。
 * - 每个标签的更新说明取标签附注（git tag -a v0.2.0 -F notes.txt）：不带「- 」的行是简介，紧跟着「- 要点」的那行是小节标题；
 *   第一行如果是标题（含标签名，例如「DaMail v0.2.0」）不显示。含中文的行算中文，其余算英文，
 *   某种语言没写时两种语言都显示写了的那种。没写附注的标签退回显示这段的提交记录。
 * - Docker 镜像里构建时没有 .git：构建镜像前（GitHub Actions 里）先运行本脚本写出 web/release.json，构建时读它；
 *   直接用源码构建镜像时没有这个文件，版本号退回 package.json 里的 version。
 *
 * 直接运行：
 * - node web/scripts/release-info.mjs：把结果（JSON）输出到标准输出
 * - node web/scripts/release-info.mjs --title v0.2.0：输出这个标签的 GitHub Release 标题
 * - node web/scripts/release-info.mjs --notes v0.2.0 [--image ghcr.io/owner/damail]：输出 GitHub Release 正文（Markdown）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { notesMarkdown, notesTitle, parseNotes } from './release-notes.mjs';

export { parseNotes };

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SAVED = fileURLToPath(new URL('../release.json', import.meta.url));

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const commits = (range) =>
  git('log', '--format=%h%x1f%ad%x1f%s', '--date=short', '--no-merges', range)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date, subject] = line.split('\x1f');
      return { sha, date, subject };
    });

function fromGit() {
  const head = git('rev-parse', '--short', 'HEAD');
  // 按创建时间从新到旧；只有附注标签（objecttype=tag）的内容是附注，轻量标签当作没写说明
  const tags = git('for-each-ref', 'refs/tags', '--sort=-creatordate', '--format=%(refname:short)%1f%(creatordate:short)%1f%(objecttype)%1f%(contents)%1e')
    .split('\x1e')
    .map((s) => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map((s) => {
      const [tag, date, type, contents] = s.split('\x1f');
      return { tag, date, notes: type === 'tag' ? parseNotes(tag, contents ?? '') : null };
    });

  let tag = null;
  let ahead = 0;
  try {
    const m = /^(.*)-(\d+)-g[0-9a-f]+$/.exec(git('describe', '--tags', '--long'));
    if (m) [tag, ahead] = [m[1], Number(m[2])];
  } catch {
    // 还没有任何标签
  }
  const releases = tags.map((r, i) => ({ ...r, commits: commits(tags[i + 1] ? `${tags[i + 1].tag}..${r.tag}` : r.tag) }));
  return {
    version: tag ? (ahead ? `${tag}+${ahead}` : tag) : head,
    tag,
    commit: head,
    releases,
    unreleased: tag && ahead ? commits(`${tag}..HEAD`) : [],
  };
}

export function releaseInfo() {
  try {
    return fromGit();
  } catch {
    if (existsSync(SAVED)) return JSON.parse(readFileSync(SAVED, 'utf8'));
    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return { version, tag: null, commit: null, releases: [], unreleased: [] };
  }
}

/** 附注标签的附注；轻量标签返回空字符串 */
export function tagMessage(tag) {
  if (git('cat-file', '-t', `refs/tags/${tag}`) !== 'tag') return '';
  return git('tag', '-l', '--format=%(contents)', tag);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const title = opt('--title');
  const notes = opt('--notes');
  if (title) process.stdout.write(notesTitle(title, tagMessage(title)) + '\n');
  else if (notes) process.stdout.write(notesMarkdown(notes, tagMessage(notes), { image: opt('--image') }));
  else process.stdout.write(JSON.stringify(releaseInfo(), null, 2) + '\n');
}
