import type { ReactNode } from 'react';

/**
 * The icon set — inline SVG, no dependency.
 *
 * Phase 10 decision D2: an icon package (lucide-react and friends) would land in
 * the INITIAL bundle, because AppLayout and the auth pages are not lazy routes.
 * The whole set below is a few kilobytes and costs nothing to tree-shake.
 *
 * Every icon is 16×16, draws with `currentColor`, and is aria-hidden — icons
 * here are decoration beside a label or inside a button that carries its own
 * aria-label. If an icon ever becomes the only content of a control, the
 * CONTROL gets the accessible name, never the glyph.
 */

export interface IconProps {
  className?: string;
}

function Svg({
  className,
  fill = 'none',
  children,
}: {
  className?: string;
  fill?: string;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill={fill}
      stroke={fill === 'none' ? 'currentColor' : 'none'}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

export function FileIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M9.5 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5.25z" />
      <path d="M9.5 1.75v3.5h3.25" />
    </Svg>
  );
}

export function FolderIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M1.75 12.75v-9a1 1 0 0 1 1-1h3l1.5 2h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" />
    </Svg>
  );
}

export function FolderOpenIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M1.75 12.75v-9a1 1 0 0 1 1-1h3l1.5 2h6a1 1 0 0 1 1 1v1.25" />
      <path d="M1.75 12.75l1.9-5.25h11.1l-1.9 5.25z" />
    </Svg>
  );
}

export function ChevronRightIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </Svg>
  );
}

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3.5 6 8 10.5 12.5 6" />
    </Svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </Svg>
  );
}

export function PencilIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M11.4 2.35 13.65 4.6l-8.15 8.15-2.9.65.65-2.9z" />
    </Svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.5 4.25l.5 9h6l.5-9" />
    </Svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  );
}

export function PlayIcon({ className }: IconProps) {
  return (
    <Svg className={className} fill="currentColor">
      <path d="M5.25 3.4v9.2a.4.4 0 0 0 .61.34l7.2-4.6a.4.4 0 0 0 0-.68l-7.2-4.6a.4.4 0 0 0-.61.34z" />
    </Svg>
  );
}

export function UsersIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5zM1.75 13.25c0-2.35 1.9-3.75 4.25-3.75s4.25 1.4 4.25 3.75" />
      <path d="M10.75 3.4a2.25 2.25 0 0 1 0 4.2M11.5 9.75c1.6.35 2.75 1.5 2.75 3.5" />
    </Svg>
  );
}

export function LogoutIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M6.25 13.75H3.5a1 1 0 0 1-1-1v-9.5a1 1 0 0 1 1-1h2.75M10.25 11l3-3-3-3M13.25 8h-7" />
    </Svg>
  );
}

export function AlertIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M8 1.75 14.75 13.75H1.25z" />
      <path d="M8 6.25v3M8 11.4h.01" />
    </Svg>
  );
}

export function InboxIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M1.75 9.5h3.5l1 2h3.5l1-2h3.5" />
      <path d="M1.75 9.5 3.6 3.25h8.8l1.85 6.25v3.25a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" />
    </Svg>
  );
}

/** The only animated icon. Used by Button's `loading` prop — decision A3 folded
 *  the spinner into Button rather than giving it a component of its own. */
export function SpinnerIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={`animate-spin ${className ?? ''}`}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ── Phase 12 additions (search + polish) ─────────────────────────────────
   Same rules as everything above: 16×16, currentColor, aria-hidden. Added
   rather than pulled from an icon package for the reason in D2 — AppLayout and
   the auth pages are eager, so a package would land in the initial chunk. */

export function SearchIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="7.25" cy="7.25" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </Svg>
  );
}

export function CopyIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1" />
      <path d="M10.25 5.75v-2a1 1 0 0 0-1-1h-5.5a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h2" />
    </Svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="m3.25 8.5 3 3 6.5-7" />
    </Svg>
  );
}

export function KeyboardIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="1.25" y="4.25" width="13.5" height="8" rx="1" />
      <path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6" />
    </Svg>
  );
}

export function TextIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3.25 4V2.75h9.5V4M8 2.75v10.5M6 13.25h4" />
    </Svg>
  );
}

export function TargetIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="8" cy="8" r="5.25" />
      <path d="M8 1.25v2M8 12.75v2M1.25 8h2M12.75 8h2" />
    </Svg>
  );
}
