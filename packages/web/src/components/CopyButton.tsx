import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { AlertCircleIcon, CheckIcon, CopyIcon } from "./Icons";

let lastAnnouncedCopyStatus = "";

function legacyCopy(text: string): boolean {
  const previousFocus = document.activeElement as HTMLElement | null;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;inset-block-start:0;opacity:0";
  document.body.append(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    previousFocus?.focus?.({ preventScroll: true });
  }
}

interface CopyButtonProps {
  text: string;
  ariaLabel: string;
  label?: string;
  className?: string;
}

export function CopyButton({
  text,
  ariaLabel,
  label,
  className = "",
}: CopyButtonProps) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [announcement, setAnnouncement] = useState("");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const report = useCallback(
    (ok: boolean) => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      setState(ok ? "copied" : "failed");
      let message = ok ? t("md.copied") : t("md.copyFailed");
      if (message === lastAnnouncedCopyStatus) {
        message += "\u00A0";
      }
      lastAnnouncedCopyStatus = message;
      setAnnouncement("");
      window.requestAnimationFrame(() => {
        setAnnouncement(message);
      });
      timerRef.current = window.setTimeout(() => {
        setState("idle");
        setAnnouncement("");
      }, 2000);
    },
    [t],
  );

  const handleClick = useCallback(async () => {
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        report(true);
        return;
      }
      if (legacyCopy(text)) {
        report(true);
      } else {
        report(false);
      }
    } catch {
      report(legacyCopy(text));
    }
  }, [text, report]);

  return (
    <span className={`copy-wrap ${className}`.trim()}>
      <button
        type="button"
        className="copy-button"
        aria-label={label ? undefined : ariaLabel}
        data-copied={state === "copied" ? "" : undefined}
        data-failed={state === "failed" ? "" : undefined}
        onClick={handleClick}
      >
        <span className="copy-icon" aria-hidden="true">
          {state === "copied" ? (
            <CheckIcon size={13} />
          ) : state === "failed" ? (
            <AlertCircleIcon size={13} />
          ) : (
            <CopyIcon size={13} />
          )}
        </span>
        {label ? <span>{label}</span> : null}
      </button>
      <span
        className="copy-tip"
        role="status"
        data-visible={state !== "idle" ? "" : undefined}
      >
        {announcement}
      </span>
    </span>
  );
}
