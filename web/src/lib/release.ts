/** 版本号和更新日志的数据结构（构建时由 web/scripts/release-info.mjs 生成，注入为 __APP_RELEASE__） */
export type ReleaseCommit = { sha: string; date: string; subject: string };
export type ReleaseNotes = { intro: string[]; sections: { title: string | null; items: string[] }[] };
export type Release = { tag: string; date: string; notes: { zh: ReleaseNotes; en: ReleaseNotes } | null; commits: ReleaseCommit[] };
export type ReleaseInfo = {
  // v0.2.0；标签之后还有提交时是 v0.2.0+3；没有标签时是提交号
  version: string;
  tag: string | null;
  commit: string | null;
  // 从新到旧
  releases: Release[];
  // 最新标签之后的提交（还没打标签）
  unreleased: ReleaseCommit[];
};

export const RELEASE: ReleaseInfo = __APP_RELEASE__;
