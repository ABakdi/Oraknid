import { Download, FileUp, PackageOpen } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorNote } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, auth, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { unlock } from "@/lib/lock";

// Moving Oraknid to another computer (ADR-061), and a job's or a project's
// records as a zip: downloads through one-time links, imports as uploads.

/** Follows a one-time download link in this browser. */
function download(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

/** This device's token and unlocked session, as the API's calls carry them. */
function lockHeaders(): Record<string, string> {
  const token = auth.token();
  const session = unlock.get();
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(session ? { "x-oraknid-unlock": session } : {}),
  };
}

/** An upload to one of Oraknid's import routes; its answer, or its error in words. */
async function upload(path: string, file: File, headers: Record<string, string> = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { ...lockHeaders(), "content-type": "application/octet-stream", ...headers },
    body: file,
  });
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(body.message ?? t("The import failed."));
  return body;
}

/** Settings → About: everything as one encrypted archive, and an archive restored. */
export function MovingCard() {
  const fresh = useLive(() => api.moving.fresh(), { topics: [] });
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [importPass, setImportPass] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const exportAll = async () => {
    setError(undefined);
    if (pass !== again) return setError(new Error(t("The two passphrases differ.")));
    setBusy(true);
    try {
      const r = await api.moving.exportAll({ passphrase: pass });
      download(r.url, r.name);
      toast.success(
        t("Exported {p} project(s), {j} job(s) and {s} secret(s).", {
          p: r.counts.projects,
          j: r.counts.jobs,
          s: r.counts.secrets,
        }),
      );
      setPass("");
      setAgain("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const importAll = async () => {
    const f = file.current?.files?.[0];
    if (!f) return setError(new Error(t("Choose the archive first.")));
    setError(undefined);
    setBusy(true);
    try {
      const r = (await upload("/api/moving/import", f, {
        "x-oraknid-passphrase": importPass,
      })) as { counts: { projects: number; jobs: number }; missing: { name: string }[] };
      setResult(
        t(
          "Ready: {p} project(s) and {j} job(s). Restart Oraknid (oraknid stop, then oraknid start) to finish; {m} project folder(s) aren't on this computer.",
          { p: r.counts.projects, j: r.counts.jobs, m: r.missing.length },
        ),
      );
      setImportPass("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-help="settings.moving">
      <CardHeader>
        <CardTitle>{t("Move to another computer")}</CardTitle>
        <CardDescription>
          {t(
            "Everything (projects, jobs, Silk, servers, settings and the keychain's secrets) in one archive encrypted to a passphrase. Projects' folders aren't in it: copy them, or clone their repos again there.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="move-pass">{t("Passphrase (12 characters or more)")}</Label>
            <Input
              id="move-pass"
              type="password"
              autoComplete="new-password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="move-again">{t("Again")}</Label>
            <Input
              id="move-again"
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          </div>
          <Button
            className="gap-1"
            disabled={busy || pass.length < 12}
            onClick={exportAll}
            data-help="settings.export-all"
          >
            <Download className="size-4" />
            {t("Export everything")}
          </Button>
        </div>
        {fresh.data ? (
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="space-y-1">
              <Label htmlFor="move-file">{t("An archive from another computer")}</Label>
              <Input id="move-file" ref={file} type="file" accept=".age" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="move-import-pass">{t("Its passphrase")}</Label>
              <Input
                id="move-import-pass"
                type="password"
                value={importPass}
                onChange={(e) => setImportPass(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              className="gap-1"
              disabled={busy || !importPass}
              onClick={importAll}
              data-help="settings.import-all"
            >
              <PackageOpen className="size-4" />
              {t("Import")}
            </Button>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            {t(
              "Importing an archive is for a fresh install, with no project or job yet; to replace this one, use oraknid import --replace with Oraknid stopped.",
            )}
          </div>
        )}
        {result ? <div className="rounded-md border p-2">{result}</div> : null}
        <ErrorNote error={error} />
      </CardContent>
    </Card>
  );
}

/** A job's or a project's records as a zip, downloaded once. */
export function ExportRecordsButton(props: { jobId: string } | { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r =
        "jobId" in props
          ? await api.records.exportJob({ id: props.jobId })
          : await api.records.exportProject({ id: props.projectId });
      download(r.url, r.name);
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="ghost" size="sm" className="gap-1" disabled={busy} onClick={run}>
      <Download className="size-4" />
      {t("Export")}
    </Button>
  );
}

/** A zip of jobs or a project, its jobs added as ended records (Settings → Storage). */
export function ImportRecordsButton({ projectId }: { projectId?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const run = async (f: File) => {
    setBusy(true);
    try {
      const r = (await upload(
        `/api/records/import${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
        f,
      )) as { imported: unknown[]; skipped: unknown[] };
      toast.success(
        t("Imported {n} job(s); {s} skipped (already here).", {
          n: r.imported.length,
          s: r.skipped.length,
        }),
      );
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void run(f);
        }}
      />
      <Button
        variant="outline"
        size="sm"
        className="gap-1"
        disabled={busy}
        onClick={() => input.current?.click()}
        data-help="settings.import-records"
      >
        <FileUp className="size-4" />
        {t("Import a job or project zip")}
      </Button>
    </>
  );
}

/** A project moved here whose folder is missing: its linked repos cloned again. */
export function CloneAgainButton({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api.moving.cloneAgain({ projectId });
          toast.success(t("Cloned {repos}.", { repos: r.cloned.join(", ") }));
        } catch (e) {
          toast.error(message(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {t("Clone again")}
    </Button>
  );
}
