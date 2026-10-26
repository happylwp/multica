"use client";

import { useEffect, useRef, useState } from "react";
import { animate } from "motion/react";

/**
 * Renders the final value immediately and only animates when the value
 * changes afterwards (live updates, realtime patches). Keeps SSR output,
 * first paint, and test assertions stable without disabling the count-up.
 */
export function AnimatedNumber({
  value,
  format,
}: {
  value: number;
  format: (v: number) => string;
}) {
  const [display, setDisplay] = useState(value);
  const previous = useRef(value);

  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (from === value) {
      return;
    }
    const controls = animate(from, value, {
      duration: 0.8,
      ease: "easeOut",
      onUpdate: setDisplay,
    });
    return () => controls.stop();
  }, [value]);

  return <span className="tabular-nums">{format(display)}</span>;
}
