import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, PencilSimple, Trash } from "@phosphor-icons/react";
import "./photo-markup.css";

const NO_MARKS = Object.freeze({ src: null, strokes: [], dataUrl: null });

// Marks belong to one exact photo. Once it is replaced they no longer apply.
export const marksFor = (value, src) => value?.src === src && value.dataUrl ? value : null;

function paint(canvas, strokes) {
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  const width = Math.max(4, canvas.width * 0.008);
  context.lineCap = "round";
  context.lineJoin = "round";
  // A pale edge keeps a red mark visible on red clothing.
  for (const [color, lineWidth] of [["#ffffff", width * 1.7], ["#e01b24", width]]) {
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    for (const stroke of strokes) {
      context.beginPath();
      stroke.forEach(([x, y], index) => context[index ? "lineTo" : "moveTo"](x * canvas.width, y * canvas.height));
      // A tap has one point, and a zero-length line still draws its round cap.
      if (stroke.length === 1) context.lineTo(stroke[0][0] * canvas.width, stroke[0][1] * canvas.height);
      context.stroke();
    }
  }
}

// Render with a key derived from src, so a replaced photo starts with no surface or marks.
export function PhotoMarkup({ src, value, disabled, className, primaryClassName, onChange }) {
  const dialog = useRef(null);
  const canvas = useRef(null);
  const drawing = useRef(null);
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState(null);
  const strokes = value?.src === src ? value.strokes : NO_MARKS.strokes;
  const preview = value?.src === src ? value.dataUrl : null;

  useEffect(() => { if (open && !dialog.current.open) dialog.current.showModal(); }, [open]);
  useEffect(() => { if (canvas.current) paint(canvas.current, strokes); }, [strokes, size, open]);

  const commit = (next) => {
    paint(canvas.current, next);
    onChange({ src, strokes: next, dataUrl: next.length ? canvas.current.toDataURL("image/png") : null });
  };
  const point = (event) => {
    const rect = canvas.current.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))];
  };
  const count = strokes.length;

  return <div className="photo-markup">
    <button type="button" className={className} disabled={disabled} onClick={() => setOpen(true)}>
      <PencilSimple size={16} aria-hidden="true" />{count ? `Edit marks (${count})` : "Mark what to change"}
    </button>
    {preview ? <span className="photo-markup-preview"><img src={src} alt="" /><img src={preview} alt="Your marks on this photo" /></span> : null}
    {open ? <dialog ref={dialog} className="photo-markup-dialog" aria-labelledby="photo-markup-title"
      // React bubbles these through the component tree into the review dialog
      // that contains this layer, which would close the review as well.
      onCancel={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
      onClose={(event) => { event.stopPropagation(); drawing.current = null; setOpen(false); setSize(null); }}>
      <div className="photo-markup-head">
        <h3 id="photo-markup-title">Mark what to change</h3>
        <p>Circle or scribble over it, then describe the change. The rest of the photo can still shift slightly, so check the result.</p>
      </div>
      <div className="photo-markup-stage">
        <div className="photo-markup-frame">
          <img src={src} alt="Photo to mark" draggable={false} onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
          {size ? <canvas ref={canvas} width={size.width} height={size.height} role="img" aria-label={`Drawing surface over the photo. ${count} ${count === 1 ? "mark" : "marks"} so far.`}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drawing.current = { id: event.pointerId, stroke: [point(event)] };
              paint(canvas.current, [...strokes, drawing.current.stroke]);
            }}
            onPointerMove={(event) => {
              if (drawing.current?.id !== event.pointerId) return;
              drawing.current.stroke.push(point(event));
              paint(canvas.current, [...strokes, drawing.current.stroke]);
            }}
            onPointerUp={(event) => {
              if (drawing.current?.id !== event.pointerId) return;
              const { stroke } = drawing.current;
              drawing.current = null;
              commit([...strokes, stroke]);
            }}
            onPointerCancel={() => { drawing.current = null; paint(canvas.current, strokes); }} /> : null}
        </div>
      </div>
      <div className="photo-markup-actions">
        <button type="button" className={className} disabled={!count} onClick={() => commit(strokes.slice(0, -1))}><ArrowCounterClockwise size={16} aria-hidden="true" />Undo</button>
        <button type="button" className={className} disabled={!count} onClick={() => commit([])}><Trash size={16} aria-hidden="true" />Clear marks</button>
        <button type="button" className={primaryClassName} onClick={() => dialog.current.close()}><Check size={16} aria-hidden="true" />Done</button>
      </div>
    </dialog> : null}
  </div>;
}
