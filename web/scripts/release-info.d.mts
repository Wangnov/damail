import type { ReleaseInfo } from '../src/lib/release';
export { parseNotes } from './release-notes.mjs';
export function releaseInfo(): ReleaseInfo;
export function tagMessage(tag: string): string;
