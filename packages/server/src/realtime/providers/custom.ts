import type { RealtimeEvent, RealtimeProvider } from '../types';
import { audienceForChannel, type ModuleEvent } from '../audience';
import { conversationChannel } from '../channels';

/**
 * The provider behind `chat.onEvent(fn)`: instead of publishing to Socket.IO rooms, the module hands each event to the
 * customer's own transport, tagged with its audience (D11).
 *
 * Removal: a removed participant always produces a `participant.removed` event naming the user (`data.userId`, `data.conversationId`),
 * whether or not the conversation is encrypted, so the transport can take them out of that conversation's room at once.
 */
export function createCustomProvider(deliver: (event: ModuleEvent) => void | Promise<void>, onUnroutable: (channel: string) => void = () => {}): RealtimeProvider {
  const prefix = conversationChannel('');
  return {
    async publish(channel: string, event: RealtimeEvent): Promise<void> {
      const audience = audienceForChannel(channel);
      if (!audience) return onUnroutable(channel);
      await deliver({ type: event.type, data: event.data, audience });
    },
    async evictUser(channel: string, userId: string): Promise<void> {
      if (!channel.startsWith(prefix)) return;
      await deliver({
        type: 'participant.removed',
        data: { conversationId: channel.slice(prefix.length), userId },
        audience: { kind: 'users', userIds: [userId] },
      });
    },
  };
}
