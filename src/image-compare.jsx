import { useRef, useState } from "react";
import { ArrowsHorizontal } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import "./image-compare.css";

// Render with a key derived from `after`, so a new image starts centred. Without
// a distinct `before`, or if either image fails to load, shows `children` alone.
export function ImageCompare({ before, after, alt, className = "", sizes, unoptimized, onLoad, children }) {
  const dragging = useRef(null);
  const [position, setPosition] = useState(50);
  const [failed, setFailed] = useState(false);
  if (!before || before === after || failed) return children;
  const moveTo = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition(Math.min(100, Math.max(0, (event.clientX - rect.left) / rect.width * 100)));
  };
  return <div className={`image-compare ${className}`}>
    <div className="image-compare-frame" style={{ "--compare-position": `${position}%` }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = event.pointerId;
        moveTo(event);
      }}
      onPointerMove={(event) => { if (dragging.current === event.pointerId) moveTo(event); }}
      onPointerUp={() => { dragging.current = null; }}
      onPointerCancel={() => { dragging.current = null; }}>
      <OptimizedImage className="image-compare-after" src={after} alt={alt} sizes={sizes} unoptimized={unoptimized} loading="eager" draggable={false} onLoad={onLoad} onError={() => setFailed(true)} />
      <OptimizedImage className="image-compare-before" src={before} alt={`Previous version: ${alt}`} sizes={sizes} unoptimized={unoptimized} loading="eager" draggable={false} onError={() => setFailed(true)} />
      <span className="image-compare-label is-before" aria-hidden="true">Previous</span>
      <span className="image-compare-label is-after" aria-hidden="true">New</span>
      <input className="image-compare-range" type="range" min="0" max="100" step="1" value={Math.round(position)} aria-label="Compare the previous and new image" aria-valuetext={`${Math.round(position)}% previous image`} onChange={(event) => setPosition(Number(event.target.value))} />
      <span className="image-compare-divider" aria-hidden="true"><span className="image-compare-handle"><ArrowsHorizontal size={18} /></span></span>
    </div>
  </div>;
}
