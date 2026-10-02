import { Delete, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorNote } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { unlock } from "@/lib/lock";

/**
 * The lock (ADR-029): a PIN pad until this device is unlocked; the first
 * PIN is set here, on the computer running Oraknid.
 */
export function LockScreen({
  pinSet,
  remote,
  onUnlocked,
}: {
  pinSet: boolean;
  remote: boolean;
  onUnlocked: () => void;
}) {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-xs space-y-6">
        <div className="flex flex-col items-center gap-2">
          <img src="/icon.svg" alt="" className="size-10" />
          <div className="flex items-center gap-1.5 text-lg font-semibold">
            <Lock className="size-4" /> Oraknid
          </div>
        </div>
        {pinSet ? (
          <PinPad onUnlocked={onUnlocked} />
        ) : remote ? (
          <p className="text-center text-sm text-muted-foreground">
            {t(
              "Set your PIN on the computer running Oraknid first (Settings → Security), then come back.",
            )}
          </p>
        ) : (
          <FirstPin onUnlocked={onUnlocked} />
        )}
      </div>
    </div>
  );
}

function PinPad({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState(false);

  const submit = async (value: string) => {
    if (busy || !value) return;
    setBusy(true);
    setError(undefined);
    try {
      const { session } = await api.lock.unlock({ pin: value });
      unlock.set(session);
      onUnlocked();
    } catch (e) {
      setError(e);
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  // A keyboard works too, on a computer.
  useEffect(() => {
    if (words) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) setPin((p) => (p.length < 12 ? p + e.key : p));
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Enter") void submit(pin);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (words)
    return (
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(pin);
        }}
      >
        <Label htmlFor="pass">{t("Your passphrase")}</Label>
        <Input
          id="pass"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />
        <ErrorNote error={error} />
        <Button type="submit" className="w-full" disabled={!pin || busy}>
          {t("Unlock")}
        </Button>
        <button
          type="button"
          className="w-full text-xs text-muted-foreground underline"
          onClick={() => {
            setWords(false);
            setPin("");
          }}
        >
          {t("Use digits")}
        </button>
      </form>
    );

  return (
    <div className="space-y-4">
      <div className="text-center text-sm text-muted-foreground">{t("Enter your PIN")}</div>
      <div className="flex h-6 items-center justify-center gap-2" aria-live="polite">
        {Array.from({ length: Math.max(6, pin.length) }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: dots have no identity
            key={i}
            className={`size-3 rounded-full border ${i < pin.length ? "bg-foreground" : ""}`}
          />
        ))}
      </div>
      <ErrorNote error={error} />
      <div className="grid grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <Digit key={d} d={d} onPress={() => setPin((p) => (p.length < 12 ? p + d : p))} />
        ))}
        <Button
          variant="ghost"
          className="h-16 text-sm"
          aria-label={t("Delete")}
          onClick={() => setPin((p) => p.slice(0, -1))}
        >
          <Delete />
        </Button>
        <Digit d="0" onPress={() => setPin((p) => (p.length < 12 ? `${p}0` : p))} />
        <Button
          className="h-16 text-base"
          disabled={pin.length < 6 || busy}
          onClick={() => void submit(pin)}
        >
          {busy ? "…" : t("Unlock")}
        </Button>
      </div>
      <button
        type="button"
        className="w-full text-xs text-muted-foreground underline"
        onClick={() => {
          setWords(true);
          setPin("");
        }}
      >
        {t("I use a passphrase")}
      </button>
    </div>
  );
}

function Digit({ d, onPress }: { d: string; onPress: () => void }) {
  return (
    <Button variant="outline" className="h-16 text-2xl font-medium" onClick={onPress}>
      {d}
    </Button>
  );
}

function FirstPin({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const valid = /^\d{6,12}$/.test(pin) || (pin.length >= 8 && /\D/.test(pin));
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { session } = await api.lock.setPin({ current: null, pin });
      unlock.set(session);
      onUnlocked();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1 text-center">
        <div className="font-medium">{t("Set your PIN")}</div>
        <p className="text-sm text-muted-foreground">
          {t(
            "Oraknid can run anything on this computer, so it opens only with your PIN: here and on your phone. 6 to 12 digits, or a passphrase.",
          )}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pin1">{t("PIN")}</Label>
        <Input
          id="pin1"
          type="password"
          autoFocus
          autoComplete="new-password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pin2">{t("Again")}</Label>
        <Input
          id="pin2"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
      </div>
      {pin && !valid ? (
        <div className="text-xs text-muted-foreground">
          {t("6 to 12 digits, or a passphrase of at least 8 characters.")}
        </div>
      ) : null}
      {again && again !== pin ? (
        <div className="text-xs text-destructive">{t("They don't match.")}</div>
      ) : null}
      <ErrorNote error={error} />
      <Button type="submit" className="w-full" disabled={!valid || again !== pin || busy}>
        {t("Set my PIN")}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        {t("Forgot it later? Run")} <code className="rounded bg-muted px-1">oraknid pin reset</code>{" "}
        {t("on this computer.")}
      </p>
    </form>
  );
}
