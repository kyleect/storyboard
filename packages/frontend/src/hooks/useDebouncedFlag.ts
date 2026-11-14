import { useEffect, useRef, useState } from "react";

/**
 * Follows `active` with some delay, so an indicator does not flicker: it
 * shows only after `showDelay` ms, and once shown stays for at least
 * `minVisible` ms. A run that ends just as the next one starts keeps it on
 * the whole time.
 */
export function useDebouncedFlag(
  active: boolean,
  showDelay = 300,
  minVisible = 600,
): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    if (active === visible) return;
    const wait = active
      ? showDelay
      : Math.max(0, minVisible - (Date.now() - shownAt.current));
    const timer = setTimeout(() => {
      if (active) shownAt.current = Date.now();
      setVisible(active);
    }, wait);
    // When `active` flips back first, this cancels the pending change.
    return () => clearTimeout(timer);
  }, [active, visible, showDelay, minVisible]);
  return visible;
}
