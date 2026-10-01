export interface Notification {
  title: string;
  /** One line: what happened and what I need to do (docs/01-Specification/Notifications.md). */
  body: string;
  /** Where clicking it leads, in the UI. */
  url?: string;
  urgency: "low" | "normal" | "critical";
  /** Notifications with the same tag replace each other (grouping). */
  tag?: string;
}

export type ChannelName = "desktop" | "push" | "email";

export interface Channel {
  name: ChannelName;
  send(notification: Notification): Promise<ChannelResult>;
}

export interface ChannelResult {
  delivered: number;
  /** Per-recipient problems, in plain words. Empty when all went out. */
  problems: string[];
}
