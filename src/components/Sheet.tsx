import { useEffect, type ReactNode } from "react";

interface SheetProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}

/** Bottom sheet on phones, centered dialog on wide screens. */
export function Sheet({ title, subtitle, onClose, children }: SheetProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sheet__header">
          <strong>{title}</strong>
          {subtitle ? <span>{subtitle}</span> : null}
        </header>
        <div className="sheet__body">{children}</div>
      </div>
    </div>
  );
}

export function SheetButton({
  icon,
  children,
  danger,
  onClick,
  disabled,
}: {
  icon?: ReactNode;
  children: ReactNode;
  danger?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className={`sheet-button${danger ? " sheet-button--danger" : ""}`}
      type="button"
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}
