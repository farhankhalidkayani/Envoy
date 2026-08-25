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

export function BuildingIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <rect x="5" y="3" width="10" height="18" rx="1.5" />
      <path d="M15 9h4v12h-4" />
      <path d="M8 7h1M11 7h1M8 10.5h1M11 10.5h1M8 14h1M11 14h1" />
    </svg>
  );
}

export function ClockListIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <circle cx="9" cy="9" r="6" />
      <path d="M9 6.2V9l2 1.4" />
      <path d="M17 8h4M17 12h4M17 16h4M3 16h8M3 20h12" />
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

export function AlertIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <path d="M12 3.5l9.5 16.5H2.5z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DollarIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <path d="M12 3v18" />
      <path d="M16.5 7.5c0-1.7-1.8-3-4.5-3s-4.5 1.2-4.5 3 1.8 2.6 4.5 3 4.5 1.3 4.5 3-1.8 3-4.5 3-4.5-1.3-4.5-3" />
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
