export interface RealtimeEvent {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export interface RealtimeProvider {
  publish(channel: string, event: RealtimeEvent): Promise<void>;
  /** Optional: take every socket of `userId` out of room `channel` (e.g. a removed participant), cluster-wide. */
  evictUser?(channel: string, userId: string): Promise<void>;
  /** Optional: called on graceful shutdown (server.ts) so clients are told to reconnect elsewhere. */
  close?(): Promise<void>;
  /** Optional: cheap gauges (connected sockets, rooms, ...) for the soak stats line in server.ts. */
  stats?(): Record<string, number>;
}
