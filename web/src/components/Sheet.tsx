import { useEffect, useRef, type FormEvent, type ReactNode } from "react";

/**
 * A side panel for forms, like the Meridian mockup's sheets. Escape or the
 * backdrop closes it. Submitting the form calls onSubmit.
 */
export function Sheet({
  eyebrow, title, onClose, onSubmit, children, footer, wide,
}: {
  eyebrow?: string;
  title: string;
  onClose: () => void;
  onSubmit?: (e: FormEvent) => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const first = panel.current?.querySelector<HTMLElement>("input, select, textarea");
    first?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <form
        ref={panel}
        className="sheet"
        style={wide ? { width: 720 } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.(e);
        }}
      >
        <div className="sh-h">
          <div>
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            <h2>{title}</h2>
          </div>
          <button type="button" className="btn ghost small x" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div className="sh-b">{children}</div>
        {footer && <div className="sh-f">{footer}</div>}
      </form>
    </>
  );
}
