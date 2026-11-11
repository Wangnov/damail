import { EventEmitter } from 'node:events';

export type HubEvent =
  | { type: 'account.status'; accountId: number; status: string; error?: string | null }
  | { type: 'messages.new'; accountId: number; folderId: number; count: number }
  | { type: 'messages.updated'; accountId: number; folderId: number }
  | { type: 'drafts.updated'; accountId: number; draftId: number; status: string }
  | { type: 'followups.updated'; accountId: number };

class EventBus extends EventEmitter {
  publish(event: HubEvent) {
    this.emit('event', event);
  }
  subscribe(listener: (event: HubEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

export const bus = new EventBus();
bus.setMaxListeners(1000);
