/** 语义化版本比较（v1.2.3、v1.3.0-beta.1） */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

type Version = { major: number; minor: number; patch: number; pre: string | null };

export function parseVersion(v: string): Version | null {
  const m = SEMVER.exec(v.trim());
  return m ? { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ?? null } : null;
}

/** 预发布版本比同号的正式版本小 */
export function compareVersions(a: Version, b: Version) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || (a.pre === b.pre ? 0 : !a.pre ? 1 : !b.pre ? -1 : a.pre < b.pre ? -1 : 1);
}

/** latest 是比 current 新的正式版本；current 不是版本号（没打过标签的开发版本）时不算 */
export function isNewerRelease(latest: string, current: string | null) {
  const a = parseVersion(latest);
  const b = current ? parseVersion(current) : null;
  return Boolean(a && !a.pre && b && compareVersions(a, b) > 0);
}
