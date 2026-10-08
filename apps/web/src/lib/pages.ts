import { useMemo, useState } from "react";

/**
 * A long list read a page at a time (Web-UI → Performance): the newest page
 * live, earlier ones read on demand and kept above it.
 */

/** Messages read per page of a conversation. */
export const CONVERSATION_PAGE = 100;

/** Earlier pages, then the live one, each item once, in order. */
export function mergePages<T extends { id: string }>(older: T[], latest: T[]): T[] {
  if (!older.length) return latest;
  const live = new Set(latest.map((x) => x.id));
  return [...older.filter((x) => !live.has(x.id)), ...latest];
}

/**
 * The earlier pages of a list whose newest page is `latest` (live): `more()`
 * reads the page before the oldest shown. `key` names the list: another
 * one starts again from its newest page.
 */
export function useEarlierPages<T extends { id: string }>(
  latest: T[] | undefined,
  key: string,
  read: (before: string) => Promise<T[]>,
  pageSize = CONVERSATION_PAGE,
) {
  const [older, setOlder] = useState<T[]>([]);
  const [olderMore, setOlderMore] = useState(true);
  const [reading, setReading] = useState(false);
  const [shownFor, setShownFor] = useState(key);
  if (shownFor !== key) {
    setShownFor(key);
    setOlder([]);
    setOlderMore(true);
  }
  const list = useMemo(() => mergePages(older, latest ?? []), [older, latest]);
  // The newest page full: there may be more before it; an earlier page short: there isn't.
  const hasMore = older.length ? olderMore : (latest?.length ?? 0) >= pageSize;
  const more = async () => {
    const first = list[0];
    if (!first || reading) return;
    setReading(true);
    try {
      const page = await read(first.id);
      setOlder((o) => mergePages(page, o));
      setOlderMore(page.length >= pageSize);
    } finally {
      setReading(false);
    }
  };
  return { list, older, hasMore, reading, more };
}
