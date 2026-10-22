export interface RealtimeEvent {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export interface RealtimeProvider {
  publish(channel: string, event: RealtimeEvent): Promise<void>;
}
