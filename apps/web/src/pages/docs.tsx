import { ArrowLeft, ArrowRight, Link2, Search, Sparkles } from "lucide-react";
import { Children, isValidElement, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { BackButton, Empty, Markdown, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { anchorOf, docHref, GUIDE, type GuidePage, guidePage, searchGuide } from "@/lib/guide";
import { askHelper } from "@/lib/helper-show";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A heading's words, whatever markdown put inside it. */
const textOf = (node: ReactNode): string =>
  Children.toArray(node)
    .map((c) =>
      typeof c === "string" || typeof c === "number"
        ? String(c)
        : isValidElement<{ children?: ReactNode }>(c)
          ? textOf(c.props.children)
          : "",
    )
    .join("");

/**
 * The guide inside Oraknid (ADR-041, Web-UI → Docs): the site's guide,
 * its pages listed beside the one open, a search over headings and text,
 * headings to link to (`/docs/<page>/<heading>`), and "Ask the helper about
 * this" on each page.
 */
export function DocsPage({ page, section }: { page?: string; section?: string }) {
  const [, go] = useLocation();
  const [q, setQ] = useState("");
  const hits = useMemo(() => (q.trim() ? searchGuide(q) : []), [q]);
  const open = guidePage(page);

  // A heading in the address: scrolled to once the page is drawn.
  useEffect(() => {
    if (!open) return;
    const el = section ? document.getElementById(`doc-${section}`) : null;
    if (el) el.scrollIntoView({ block: "start" });
    else document.querySelector("main")?.scrollTo({ top: 0 });
  }, [open, section]);

  const search = (
    <div className="relative" data-help="docs.search">
      <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
      <Input
        type="search"
        className="pl-8"
        placeholder={t("Search the guide")}
        aria-label={t("Search the guide")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) {
            go(hits[0].href);
            setQ("");
          }
          if (e.key === "Escape") setQ("");
        }}
      />
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl">
      <div className={cn(open && "hidden md:block")}>
        <PageHeader
          title={t("Docs")}
          sub={t("The guide: how to install, run and use Oraknid. The same as on the site.")}
        />
      </div>
      <div className="grid gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className={cn("space-y-3", open && "hidden md:block")}>
          {search}
          <nav aria-label={t("The guide's pages")} data-help="docs.pages" className="space-y-0.5">
            {GUIDE.map((p) => (
              <Link
                key={p.slug}
                href={`/docs/${p.slug}`}
                aria-current={p.slug === open?.slug ? "page" : undefined}
                className={cn(
                  "block rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:py-2.5",
                  p.slug === open?.slug && "bg-accent font-medium text-accent-foreground",
                )}
              >
                {p.title}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="min-w-0">
          {q.trim() ? (
            <Results q={q} hits={hits} onPick={() => setQ("")} />
          ) : open ? (
            <Page page={open} />
          ) : (
            <Index />
          )}
        </div>
      </div>
    </div>
  );
}

function Results({
  q,
  hits,
  onPick,
}: {
  q: string;
  hits: ReturnType<typeof searchGuide>;
  onPick: () => void;
}) {
  if (!hits.length)
    return (
      <Empty title={t("Nothing in the guide matches")}>
        {t("Try other words, or ask the helper: it knows the guide and the screens.")}
      </Empty>
    );
  return (
    <section aria-label={t("Search results")} className="space-y-2">
      <div className="text-xs text-muted-foreground">
        {t("{n} place(s) in the guide for “{q}”", { n: hits.length, q: q.trim() })}
      </div>
      {hits.map((h) => (
        <Link
          key={h.href}
          href={h.href}
          onClick={onPick}
          className="block rounded-lg border bg-card px-3 py-2.5 hover:border-primary/50"
        >
          <div className="text-sm font-medium">
            {h.title}
            {h.heading ? <span className="text-muted-foreground"> › {h.heading}</span> : null}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {h.snippet}
          </div>
        </Link>
      ))}
    </section>
  );
}

function Index() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {GUIDE.map((p) => (
        <Link
          key={p.slug}
          href={`/docs/${p.slug}`}
          className="group flex items-start gap-2 rounded-lg border bg-card px-4 py-3 shadow-raised hover:border-primary/50"
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium">{p.title}</div>
            <div className="text-sm text-muted-foreground">{p.line}</div>
          </div>
          <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
        </Link>
      ))}
    </div>
  );
}

function Page({ page }: { page: GuidePage }) {
  const at = GUIDE.findIndex((p) => p.slug === page.slug);
  const prev = GUIDE[at - 1];
  const next = GUIDE[at + 1];
  // Headings carry their anchor, and a link to it on hover.
  const heading =
    (Tag: "h2" | "h3" | "h4") =>
    ({ children }: { children?: ReactNode }) => {
      const id = anchorOf(textOf(children));
      return (
        <Tag id={`doc-${id}`} className="group scroll-mt-4">
          {children}{" "}
          <Link
            href={`/docs/${page.slug}/${id}`}
            replace
            aria-label={t("Link to this heading")}
            className="inline-flex align-middle text-muted-foreground no-underline opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-60"
          >
            <Link2 className="size-3.5" />
          </Link>
        </Tag>
      );
    };
  return (
    <article className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <BackButton fallback="/docs" label={t("The guide")} className="md:hidden" />
        <span className="flex-1" />
        <Button
          data-help="docs.ask"
          variant="secondary"
          size="sm"
          className="gap-1.5"
          onClick={() => askHelper({ about: page.slug, title: page.title })}
        >
          <Sparkles className="size-4" />
          {t("Ask the helper about this")}
        </Button>
      </div>
      <Markdown
        text={page.body}
        className="max-w-3xl text-[15px] [&_h1]:text-[22px] [&_h1]:leading-8 [&_h1]:tracking-[-0.015em] [&_h2]:pt-3 [&_h2]:text-lg [&_h3]:pt-2 [&_h3]:text-base"
        components={{
          h2: heading("h2"),
          h3: heading("h3"),
          h4: heading("h4"),
          // The site's links (`jobs.html`) are this app's pages.
          a: ({ node: _n, href, ...props }) => {
            const to = href ? docHref(href) : "";
            return /^\/(?!\/)/.test(to) ? (
              <Link href={to} {...props} />
            ) : (
              <a href={href} {...props} target="_blank" rel="noreferrer" />
            );
          },
        }}
      />
      <nav aria-label={t("Next and previous")} className="flex max-w-3xl gap-3 border-t pt-4">
        {prev ? (
          <Link
            href={`/docs/${prev.slug}`}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:border-primary/50"
          >
            <ArrowLeft className="size-4 shrink-0" />
            <span className="min-w-0">
              <span className="block text-xs text-muted-foreground">{t("Previous")}</span>
              <span className="block truncate">{prev.title}</span>
            </span>
          </Link>
        ) : (
          <span className="flex-1" />
        )}
        {next ? (
          <Link
            href={`/docs/${next.slug}`}
            className="flex min-w-0 flex-1 items-center justify-end gap-2 rounded-lg border px-3 py-2 text-right text-sm hover:border-primary/50"
          >
            <span className="min-w-0">
              <span className="block text-xs text-muted-foreground">{t("Next")}</span>
              <span className="block truncate">{next.title}</span>
            </span>
            <ArrowRight className="size-4 shrink-0" />
          </Link>
        ) : (
          <span className="flex-1" />
        )}
      </nav>
    </article>
  );
}
