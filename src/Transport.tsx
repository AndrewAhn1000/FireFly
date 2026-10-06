interface Props {
  live: boolean;
  spanMs: number;      // how much history is buffered
  positionMs: number;  // where the view is in it: 0 the oldest frame, spanMs the newest
  onToggle(): void;    // pause on the current frame, or return to live
  onSeek(ms: number): void;
  onJump(ms: number): void;
  onStep(direction: -1 | 1): void;
  onLive(): void;
}

export default function Transport({ live, spanMs, positionMs, onToggle, onSeek, onJump, onStep, onLive }: Props) {
  const empty = spanMs <= 0;
  const behind = Math.max(0, spanMs - positionMs);
  return (
    <div className="vp-transport">
      <button className="tp-btn tp-btn-main" onClick={onToggle} title={live ? 'Pause (Space)' : 'Resume live (Space)'}>
        {live ? '❚❚' : '▶'}
      </button>
      <button className="tp-btn" onClick={() => onJump(-5000)} disabled={empty} title="Back 5 seconds (Shift+←)">«</button>
      <button className="tp-btn" onClick={() => onStep(-1)} disabled={empty} title="Back one frame (←)">‹</button>
      <button className="tp-btn" onClick={() => onStep(1)} disabled={empty || live} title="Forward one frame (→)">›</button>
      <button className="tp-btn" onClick={() => onJump(5000)} disabled={empty || live} title="Forward 5 seconds (Shift+→)">»</button>
      <input
        type="range" className="tp-scrub" min={0} max={Math.max(spanMs, 1)} step="any"
        value={live ? spanMs : Math.min(positionMs, spanMs)} disabled={empty}
        onChange={e => onSeek(Number(e.target.value))}
        onPointerUp={e => e.currentTarget.blur()}
        title="Drag back to pause and rewind"
      />
      <span className={`tp-time ${live ? 'tp-time-live' : ''}`}>{live ? 'LIVE' : `−${(behind / 1000).toFixed(1)} s`}</span>
      <button className={`tp-live ${live ? 'tp-live-on' : ''}`} onClick={onLive} disabled={live} title="Jump to the live view (End)">
        <span className="tp-live-dot" /> LIVE
      </button>
    </div>
  );
}
