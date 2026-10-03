import {
  NoRclone,
  PlacementCard,
  PoolBrowser,
  ProvidersCard,
  useProviders,
} from "@/components/cloud-storage";
import { ErrorNote, Loading, PageHeader } from "@/components/common";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

/**
 * Cloud storage (ADR-046, Web-UI → Cloud storage): the pool first, my
 * providers and where uploads go beside it (below it on a phone). The
 * folder I'm in is in the address: /storage/<path>.
 */
export function StoragePage({ path = "" }: { path?: string }) {
  const status = useLive(() => api.cloud.status(), { topics: [] });
  const providers = useProviders();
  const folder = path
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/");
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={t("Cloud storage")}
        sub={t(
          "Your storage accounts as one pool: upload, and Oraknid puts each file where it fits.",
        )}
      />
      {status.data && !status.data.rclone.found ? (
        <NoRclone fix={status.data.rclone.fix} />
      ) : providers.error ? (
        <ErrorNote error={providers.error} />
      ) : !providers.data ? (
        <Loading rows={4} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <PoolBrowser path={folder} providers={providers.data} />
          <div className="space-y-4">
            <ProvidersCard providers={providers.data} />
            {providers.data.length ? <PlacementCard providers={providers.data} /> : null}
          </div>
        </div>
      )}
    </div>
  );
}
