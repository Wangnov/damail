import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { parseNotes } from '../../scripts/release-notes.mjs';
import { api, type LatestRelease, type UpdateStatus } from '../api';
import { RELEASE, type ReleaseNotes } from '../lib/release';
import { isNewerRelease } from '../lib/version';

const KEY = ['updates'];

/** GitHub 上最新的正式版本：服务端每 6 小时查一次，这里每小时问一次服务端 */
export function useUpdateStatus() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<UpdateStatus>('/api/admin/updates'),
    staleTime: 60 * 60_000,
    refetchInterval: 60 * 60_000,
    retry: false,
  });
}

export type NewRelease = LatestRelease & { notes: { zh: ReleaseNotes; en: ReleaseNotes } | null };

/** 比当前运行的版本新的正式版本，没有时为 null；更新说明按标签附注的写法解析 Release 正文 */
export function useNewRelease(): NewRelease | null {
  const { data } = useUpdateStatus();
  return useMemo(() => {
    const latest = data?.latest;
    if (!latest || !isNewerRelease(latest.tag, RELEASE.tag)) return null;
    return { ...latest, notes: parseNotes(latest.tag, latest.body) };
  }, [data]);
}

/** 「检查更新」按钮：让服务端立即重新查一次（服务端限制最短间隔 1 分钟） */
export function useCheckUpdates() {
  const qc = useQueryClient();
  return async () => {
    const status = await api<UpdateStatus>('/api/admin/updates?refresh=1');
    qc.setQueryData(KEY, status);
    return status;
  };
}
