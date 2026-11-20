import { hueFor, initials } from './util';

export function Avatar({ name, size = 36, group = false }: { name: string; size?: number; group?: boolean }) {
  return (
    <span className={`avatar ${group ? 'group' : ''}`} style={{ width: size, height: size, fontSize: size * 0.38, background: hueFor(name) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
