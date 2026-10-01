import { monotonicFactory } from "ulid";

/** ULIDs that sort in creation order even within the same millisecond. */
export const newId: (seedTime?: number) => string = monotonicFactory();
