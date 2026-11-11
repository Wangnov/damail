#!/usr/bin/env node
/**
 * 发布新版本：检查 → 写更新说明 → 打附注标签 → 推送。推送标签后 GitHub Actions 构建镜像、创建 Release（见 https://damail.app/docs/releasing/）。
 *
 * 用法：
 *   pnpm release 0.2.0            指定版本号（v 可省略），预发布写成 0.3.0-beta.1
 *   pnpm release patch|minor|major 在最新版本上加一
 * 选项：
 *   --notes <文件>   用写好的更新说明，不打开编辑器
 *   --skip-checks    跳过类型检查和测试
 *   --no-push        只在本地打标签，不推送
 *   --dry-run        只检查和预览更新说明，不打标签（允许工作区有未提交修改）
 *   -y, --yes        不再确认
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { notesMarkdown, parseNotes } from '../web/scripts/release-notes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAIN = 'main';
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};
const step = (s) => console.log(`\n${c.bold('==>')} ${s}`);
const fail = (s) => {
  console.error(`\n${c.red('✗')} ${s}`);
  process.exit(1);
};

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};
const run = (cmd, args) => {
  console.log(c.dim(`$ ${cmd} ${args.join(' ')}`));
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' }).status === 0;
};

// ---- 参数 ----
const argv = process.argv.slice(2);
const flag = (...names) => names.some((n) => argv.includes(n));
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const opts = {
  notes: value('--notes'),
  skipChecks: flag('--skip-checks'),
  push: !flag('--no-push'),
  dryRun: flag('--dry-run'),
  yes: flag('-y', '--yes'),
};
const target = argv.find((a, i) => !a.startsWith('-') && argv[i - 1] !== '--notes');
if (!target || flag('-h', '--help')) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('*/')[0]
      .replace(/^#!.*\n\/\*\*\n?/, '')
      .replace(/^ \* ?/gm, ''),
  );
  process.exit(target ? 0 : 1);
}

const parse = (v) => {
  const m = SEMVER.exec(v);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null } : null;
};
// 预发布版本比同号正式版本小；预发布之间按字符串比
const compare = (a, b) =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch || (a.pre === b.pre ? 0 : !a.pre ? 1 : !b.pre ? -1 : a.pre < b.pre ? -1 : 1);

// 先拉取 origin 的标签，版本号要和远程比较
const remote = tryGit('remote', 'get-url', 'origin');
const fetchFailed = remote ? tryGit('fetch', '--tags', 'origin', MAIN) === null : false;

const tags = (tryGit('tag', '-l', 'v*') ?? '')
  .split('\n')
  .filter((t) => parse(t))
  .sort((a, b) => compare(parse(b), parse(a)));
const latest = tags[0] ?? null;
const latestStable = tags.find((t) => !parse(t).pre) ?? null;

let version;
if (['patch', 'minor', 'major'].includes(target)) {
  const v = parse(latestStable ?? 'v0.0.0');
  version = target === 'major' ? `v${v.major + 1}.0.0` : target === 'minor' ? `v${v.major}.${v.minor + 1}.0` : `v${v.major}.${v.minor}.${v.patch + 1}`;
} else {
  if (!parse(target)) fail(`版本号格式不对：${target}（例如 0.2.0、0.3.0-beta.1，或 patch / minor / major）`);
  version = `v${target.replace(/^v/, '')}`;
}

const ask = async (question) => {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) fail('需要确认，但当前不是交互终端；确认无误后加 --yes');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} ${c.dim('[y/N]')} `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
};

// ---- 检查 ----
step(`准备发布 ${c.bold(version)}${latest ? c.dim(`（上个版本 ${latest}）`) : c.dim('（第一个版本）')}`);

if (tags.includes(version)) fail(`标签 ${version} 已经存在`);
if (latest && compare(parse(version), parse(latest)) <= 0) fail(`${version} 不比现有的 ${latest} 新`);

const branch = tryGit('rev-parse', '--abbrev-ref', 'HEAD');
const dirty = tryGit('status', '--porcelain');
const problems = [];
if (branch !== MAIN) problems.push(`当前在 ${branch} 分支，应在 ${MAIN} 上发布`);
if (dirty) problems.push('工作区有未提交的修改（标签只包含已提交的内容），先提交或暂存');
if (!remote) console.log(c.yellow('还没有配置 origin 远程：标签只会打在本地'));
else if (fetchFailed) problems.push('拉取 origin 失败，检查网络');
else {
  const behind = Number(tryGit('rev-list', '--count', `HEAD..origin/${MAIN}`) ?? 0);
  if (behind) problems.push(`本地落后 origin/${MAIN} ${behind} 个提交，先 git pull`);
}

if (problems.length) {
  for (const p of problems) console.log(`${opts.dryRun ? c.yellow('!') : c.red('✗')} ${p}`);
  if (!opts.dryRun) process.exit(1);
}

if (opts.skipChecks) console.log(c.yellow('已跳过类型检查和测试'));
else {
  step('类型检查');
  if (!run('pnpm', ['typecheck'])) fail('类型检查没通过');
  step('服务端测试（需要本地开发数据库：docker compose -f docker-compose.dev.yml up -d db）');
  if (!run('pnpm', ['test'])) fail('测试没通过');
}

// ---- 更新说明 ----
const commits = (tryGit('log', '--format=%s', '--no-merges', latest ? `${latest}..HEAD` : 'HEAD') ?? '').split('\n').filter(Boolean);
if (!commits.length) fail(`${latest} 之后没有新的提交`);

const gitDir = git('rev-parse', '--absolute-git-dir');
const notesFile = path.join(gitDir, 'RELEASE_NOTES');
let message;
if (opts.notes) {
  if (!existsSync(opts.notes)) fail(`找不到更新说明文件：${opts.notes}`);
  message = readFileSync(opts.notes, 'utf8');
} else {
  step('写更新说明（保存并关闭编辑器后继续）');
  // 上次没发布成功时留下的草稿接着用
  const draft =
    existsSync(notesFile) && readFileSync(notesFile, 'utf8').includes(`DaMail ${version}\n`)
      ? readFileSync(notesFile, 'utf8')
      : [
          `DaMail ${version}`,
          '',
          '（一两句话介绍这个版本，不需要可以删掉这行）',
          '',
          '更新内容',
          ...commits.map((s) => `- ${s}`),
          '',
          '# 第一行是标题。不带「- 」的行是简介；紧跟着「- 要点」的那行是小节标题，可以分成「新功能」「改进」「修复」等几节。',
          '# 想同时写英文就再写一份（含中文的行算中文，其余算英文），界面按语言显示对应的那份。',
          '# 以 # 开头的行会被忽略；删光所有内容则取消发布。',
          `# ${latest ?? '开始'} 以来的提交（${commits.length} 个）已经列在上面，改成用户看得懂的说法。`,
          '',
        ].join('\n');
  writeFileSync(notesFile, draft);
  const editor = tryGit('var', 'GIT_EDITOR') || process.env.EDITOR || 'vi';
  // 编辑器可能带参数（例如 code --wait），交给 shell 解析
  const r = spawnSync('sh', ['-c', `${editor} "$1"`, 'editor', notesFile], { stdio: 'inherit' });
  if (r.status !== 0) fail('编辑器异常退出，已取消');
  message = readFileSync(notesFile, 'utf8');
}
// 和 git tag 默认的 cleanup=strip 一致：去掉 # 开头的行和首尾空行
message = message
  .split('\n')
  .filter((l) => !l.startsWith('#'))
  .join('\n')
  .replace(/^\s+|\s+$/g, '');
if (!message) fail('更新说明是空的，已取消');
if (message.includes('（一两句话介绍这个版本')) fail(`更新说明里还留着占位文字，改完再发布（草稿保存在 ${notesFile}）`);

const notes = parseNotes(version, message);
if (!notes) fail('没有读到任何更新内容');
step('预览（GitHub Release 正文）');
console.log(
  notesMarkdown(version, message)
    .trimEnd()
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n'),
);

if (opts.dryRun) {
  console.log(`\n${c.green('✓')} 预演完成，没有打标签。`);
  process.exit(0);
}

// ---- 打标签、推送 ----
const pushing = opts.push && remote;
const plan = pushing ? `打标签 ${version} 并推送 ${MAIN} 和标签到 origin（${remote}）` : `在本地打标签 ${version}`;
if (!(await ask(`${plan}？`))) fail(`已取消，草稿保存在 ${notesFile}`);

writeFileSync(notesFile, message + '\n');
if (!run('git', ['tag', '-a', version, '-F', notesFile, '--cleanup=strip'])) fail('打标签失败');
console.log(`${c.green('✓')} 已创建标签 ${version}`);

if (!pushing) {
  console.log(
    remote
      ? `\n推送：git push --atomic origin ${MAIN} ${version}`
      : `\n配置远程后推送：git remote add origin <地址> && git push --atomic origin ${MAIN} ${version}`,
  );
  console.log(`撤销：git tag -d ${version}`);
  process.exit(0);
}

step('推送');
if (!run('git', ['push', '--atomic', 'origin', MAIN, version])) {
  fail(`推送失败，标签还在本地。处理好后重试：git push --atomic origin ${MAIN} ${version}（放弃：git tag -d ${version}）`);
}
const gh = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote);
console.log(
  `\n${c.green('✓')} 已发布 ${version}。GitHub Actions 正在检查、构建镜像并创建 Release${gh ? `：\n  https://github.com/${gh[1]}/${gh[2]}/actions` : ''}`,
);
