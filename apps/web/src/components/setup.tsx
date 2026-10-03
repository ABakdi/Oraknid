import type { ServerView } from "@oraknid/contracts";
import { Bot, GitBranch, Plus, Server, Wrench } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "wouter";
import { AddLeg } from "@/components/add-leg";
import { AddServer } from "@/components/add-server";
import { FindAgents } from "@/components/find-agents";
import { GitHubCard } from "@/components/github-card";
import { ToolsCard } from "@/components/tools-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/lib/i18n";
import { FROM_PAGE } from "@/lib/nav";

/**
 * Setting something up where I need it (Web-UI → Set up in place): a page
 * that depends on a Leg, a tool, GitHub or a server offers it right there,
 * in a dialog holding the same card as Settings, with Settings a link away.
 */
function SetupDialog({
  open,
  onOpenChange,
  title,
  description,
  settings,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  /** Where the same thing lives in Settings. */
  settings?: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {/* The card as in Settings, without its frame. */}
        <div className="min-w-0 [&>[data-slot=card]]:gap-4 [&>[data-slot=card]]:border-0 [&>[data-slot=card]]:bg-transparent [&>[data-slot=card]]:py-0 [&>[data-slot=card]]:shadow-none [&>[data-slot=card]>[data-slot=card-content]]:px-0 [&>[data-slot=card]>[data-slot=card-header]]:px-0 [&>[data-slot=card]>[data-slot=card-header]>[data-slot=card-title]]:hidden">
          {children}
        </div>
        <DialogFooter className="items-center">
          {settings ? (
            <Link
              href={settings}
              state={FROM_PAGE}
              className="mr-auto text-xs text-muted-foreground underline underline-offset-2"
              onClick={() => onOpenChange(false)}
            >
              {t("Open in Settings")}
            </Link>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>{t("Done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Size = "default" | "sm";

/** Tools a skill needs and that aren't ready (ADR-021): set them up here. */
export function ToolsSetupButton({
  missing,
  size = "sm",
  variant = "secondary",
}: {
  missing: string[];
  size?: Size;
  variant?: "default" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant={variant} className="gap-1" onClick={() => setOpen(true)}>
        <Wrench className="size-3.5" />
        {missing.length
          ? t("Set up {tools}", { tools: missing.join(", ") })
          : t("Tools for skills")}
      </Button>
      <SetupDialog
        open={open}
        onOpenChange={setOpen}
        title={t("Tools for skills")}
        description={
          missing.length
            ? t("Add {tools}, or the secret it is missing. A job can start once it is ready.", {
                tools: missing.join(", "),
              })
            : undefined
        }
        settings="/settings/connections"
      >
        <ToolsCard />
      </SetupDialog>
    </>
  );
}

/** GitHub, for new or cloned repos (ADR-023), connected from where it is needed. */
export function GitHubSetupButton({ size = "sm" }: { size?: Size }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant="secondary" className="gap-1" onClick={() => setOpen(true)}>
        <GitBranch className="size-3.5" />
        {t("Connect GitHub")}
      </Button>
      <SetupDialog
        open={open}
        onOpenChange={setOpen}
        title={t("Connect GitHub")}
        settings="/settings/connections"
      >
        <GitHubCard />
      </SetupDialog>
    </>
  );
}

/** A Leg when there is none to use: found on this machine, or added by hand. */
export function AddLegButtons({ size = "default" }: { size?: Size }) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <FindAgents size={size} />
      <Button size={size} className="gap-1" onClick={() => setAdding(true)}>
        <Bot className="size-4" />
        {t("Add a Leg")}
      </Button>
      <AddLeg open={adding} onOpenChange={setAdding} />
    </>
  );
}

/** A server added from where it is needed; `onAdded` gets it (to tick it, say). */
export function AddServerButton({
  onAdded,
  size = "sm",
  label = t("Add a server"),
}: {
  onAdded?: (s: ServerView) => void;
  size?: Size;
  label?: string;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <Button size={size} variant="secondary" className="gap-1" onClick={() => setAdding(true)}>
        {size === "sm" ? <Plus className="size-3.5" /> : <Server className="size-4" />}
        {label}
      </Button>
      <AddServer open={adding} onOpenChange={setAdding} onAdded={onAdded} />
    </>
  );
}
