import type { Router } from "@oraknid/daemon/src/api/router.ts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { remote, remoteFetch } from "./remote";
import { store } from "./store";

/** This device's token (Security → pairing); away from home, the loader holds it. */
export const auth = {
  token: () => (remote() ? "remote" : store.get("token")),
  set: (token: string | null) => store.set("token", token),
};

/** Called when the daemon says this device isn't paired (any more). */
export let onUnauthorized: () => void = () => {};
export const setOnUnauthorized = (fn: () => void) => {
  onUnauthorized = fn;
};

export const api: RouterClient<Router> = createORPCClient(
  new RPCLink({
    // Inside the loader's frame the origin is opaque: any base will do, only the path travels.
    url: remote() ? "http://oraknid.remote/api" : `${location.origin}/api`,
    headers: () => {
      const token = auth.token();
      return token ? { authorization: `Bearer ${token}` } : {};
    },
    fetch: async (request, init) => {
      const t = remote();
      const res = t ? await remoteFetch(t, request as Request) : await fetch(request, init);
      if (res.status === 401) onUnauthorized();
      return res;
    },
  }),
);

/** The sentence an error carries for me (BR-17), whatever its shape. */
export function message(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String((error as { message: unknown }).message);
  return String(error);
}
