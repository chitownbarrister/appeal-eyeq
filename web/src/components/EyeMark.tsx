export function EyeMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M3 16c3.4-5.6 7.7-8.5 13-8.5S25.6 10.4 29 16c-3.4 5.6-7.7 8.5-13 8.5S6.4 21.6 3 16Z" fill="none" stroke="#F7F5F0" strokeWidth="1.8" />
      <circle cx="16" cy="16" r="4.6" fill="#B8733E" />
      <circle cx="17.6" cy="14.4" r="1.2" fill="#F7F5F0" />
    </svg>
  );
}
