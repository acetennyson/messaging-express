export function Lock({ size = 16 }: { size?: number }) {
  return (
    <svg className="lock" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.8" fill="currentColor" /><path d="M5.2 7V5.3a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
  );
}
