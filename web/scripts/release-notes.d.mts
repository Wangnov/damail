import type { ReleaseNotes } from '../src/lib/release';
export function parseNotes(tag: string | null, message: string): { zh: ReleaseNotes; en: ReleaseNotes } | null;
export function notesTitle(tag: string, message: string): string;
export function notesMarkdown(tag: string, message: string, opts?: { image?: string }): string;
