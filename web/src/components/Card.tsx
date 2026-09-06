/*
 * Adapted from signum-node (GPL-3.0), web/src/components/ui/Card.tsx, by way of
 * the admin panel's copy in src/admin/components/Card.tsx.
 *
 * Deliberately NOT the admin version: that one animates with framer-motion,
 * which forces "use client" and ships a runtime to every visitor. A status page
 * is read, not operated, so this renders on the server as static markup and the
 * hover lift is done in CSS.
 */
const cn = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

export function Card({
  children,
  className,
  padding = true,
}: {
  children?: React.ReactNode;
  className?: string;
  padding?: boolean;
}) {
  return (
    <div
      className={cn("relative backdrop-blur-[8px]", padding && "p-5", className)}
      style={{ background: "var(--panel)", border: "1px solid var(--border)" }}
    >
      {/* Tactical accent: top-left and bottom-right only */}
      <div className="pointer-events-none absolute -left-px -top-px h-[14px] w-[14px] border-l-2 border-t-2 border-[var(--blue2)]" />
      <div className="pointer-events-none absolute -bottom-px -right-px h-[14px] w-[14px] border-b-2 border-r-2 border-[var(--blue2)]" />
      {children}
    </div>
  );
}

export function CardLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "mb-2.5 text-[9px] font-semibold uppercase tracking-[3px] text-[var(--blue2)]",
        className,
      )}
    >
      {children}
    </p>
  );
}

export function CardSub({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("mt-1.5 text-[10px] tracking-[1px] text-[var(--muted)]", className)}>
      {children}
    </p>
  );
}
