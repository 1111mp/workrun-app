import { useCallback, useEffect, useRef, useState } from 'react';

/** Presentation only: the model's complete text and tool calls stay untouched. */
export function useTypewriterText(text: string, animate: boolean) {
  // Keep animating the same message through the stream-to-history handoff.
  // Messages mounted from saved history are displayed immediately.
  const animated = useRef(animate);
  const [visible, setVisible] = useState(animate ? '' : text);
  const target = useRef<string[]>([]);
  const shown = useRef(0);
  const frame = useRef<number | undefined>(undefined);
  const previousTime = useRef(0);
  const credit = useRef(0);
  const reducedMotion = useRef(false);

  const schedule = useCallback(function scheduleFrame() {
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame((now) => {
      frame.current = undefined;
      const remaining = target.current.length - shown.current;
      if (reducedMotion.current || document.hidden) {
        shown.current = target.current.length;
      } else {
        const elapsed = Math.min(
          64,
          previousTime.current ? now - previousTime.current : 16,
        );
        // Catch up smoothly after large network chunks without leaving seconds
        // of queued text after the provider has already finished.
        credit.current += (Math.max(45, remaining / 0.35) * elapsed) / 1000;
        const count = Math.floor(credit.current);
        credit.current -= count;
        shown.current = Math.min(target.current.length, shown.current + count);
      }
      previousTime.current = now;
      setVisible(target.current.slice(0, shown.current).join(''));
      if (shown.current < target.current.length) scheduleFrame();
      else {
        previousTime.current = 0;
        credit.current = 0;
      }
    });
  }, []);

  useEffect(() => {
    if (!animated.current) return;
    const next = Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      (part) => part.segment,
    );
    // An authoritative provider snapshot may correct earlier text. Retain only
    // the matching visible prefix, and never split emoji or combining marks.
    let common = 0;
    while (common < shown.current && next[common] === target.current[common])
      common++;
    shown.current = common;
    target.current = next;
    schedule();
  }, [text, schedule]);

  useEffect(() => {
    if (!animated.current) return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion.current = media.matches;
    const onMotionChange = () => {
      reducedMotion.current = media.matches;
      schedule();
    };
    const onVisibilityChange = () => {
      if (!document.hidden) schedule();
    };
    media.addEventListener('change', onMotionChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      media.removeEventListener('change', onMotionChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [schedule]);

  return animated.current ? visible : text;
}
