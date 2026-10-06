import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function InfoTip({ text, wide }: { text: string; wide?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; cx: number } | null>(null);
  return (
    <span ref={ref} className="train-info"
      onMouseEnter={() => {
        const r = ref.current?.getBoundingClientRect();
        if (r) setAnchor({ top: r.top, cx: r.left + r.width / 2 });
      }}
      onMouseLeave={() => setAnchor(null)}
    >
      ⓘ
      {anchor && createPortal(
        <div className={`train-tip-portal${wide ? ' train-tip-wide' : ''}`}
             style={{ top: anchor.top - 8, left: anchor.cx }}>
          {text}
        </div>,
        document.body,
      )}
    </span>
  );
}
