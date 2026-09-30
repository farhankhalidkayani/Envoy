interface IconProps {
  size?: number;
}

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function BotIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 8V4" />
      <circle cx="12" cy="3" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="9" cy="14" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="14" r="1.3" fill="currentColor" stroke="none" />
      <path d="M9 18h6" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
    </svg>
  );
}

export function ChatIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <path d="M4 5h16v11H9l-4 3.5V16H4z" />
      <path d="M8 9.5h8" />
      <path d="M8 12.5h5" />
    </svg>
  );
}

export function SyncIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <path d="M4 12a8 8 0 0 1 14-5.2M20 12a8 8 0 0 1-14 5.2" />
      <path d="M18 3v4h-4" />
      <path d="M6 21v-4h4" />
    </svg>
  );
}

export function CardIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10.5h18" />
      <path d="M7 15h4" />
    </svg>
  );
}

export function CheckCircleIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12.3l2.4 2.4L15.7 9.5" />
    </svg>
  );
}

export function PulseIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <path d="M3 12h4l2 7 4-14 2 7h6" />
    </svg>
  );
}

export function PlugIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <path d="M9 3v5M15 3v5" />
      <rect x="6" y="8" width="12" height="7" rx="2" />
      <path d="M12 15v3a3 3 0 0 1-3 3H7" />
    </svg>
  );
}

export function FormIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <rect x="4" y="3" width="16" height="18" rx="2.5" />
      <path d="M8 8h8" />
      <rect x="8" y="11.5" width="8" height="3" rx="1" />
      <path d="M8 18h4" />
    </svg>
  );
}

export function UsersIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M14.5 14.3c2.4.3 4.5 2.4 4.5 5.7" />
    </svg>
  );
}

export function SettingsIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.5 1.5M7.1 16.9l-1.5 1.5M18.4 18.4l-1.5-1.5M7.1 7.1 5.6 5.6" />
    </svg>
  );
}

export function LogoMark({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M5 7.5L12 4l7 3.5v9L12 20l-7-3.5v-9z"
        stroke="white"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      <path d="M5 7.5L12 11l7-3.5" stroke="white" strokeWidth={1.6} strokeLinejoin="round" />
      <path d="M12 11v9" stroke="white" strokeWidth={1.6} />
    </svg>
  );
}
