import { useRef } from 'react';
import { ArrowLeft, ArrowRight } from '@phosphor-icons/react';

export function ReorderableItem({ item, children, previous, next, busy, drag, setDrag, onMove }) {
  const pointer = useRef(null);
  const name = item.name || 'Piece';
  const finish = (event, cancel = false) => {
    const start = pointer.current;
    if (!start || start.pointerId !== event.pointerId) return;
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
    if (!cancel && start.targetId) onMove(item.id, start.targetId);
  };
  return (
    <div className={`reorder-item${drag?.id === item.id ? ' is-dragging' : ''}${drag?.targetId === item.id ? ' is-drop-target' : ''}`}
      data-reorder-id={item.id} data-reorder-part={item.part}>
      <div className="reorder-grip" role="button" tabIndex={busy ? -1 : 0}
        aria-label={`Rearrange ${name}`} aria-describedby="reorder-help" aria-disabled={busy}
        onKeyDown={event => {
          const target = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? previous : ['ArrowRight', 'ArrowDown'].includes(event.key) ? next : null;
          if (event.key === 'Escape') { pointer.current = null; setDrag(null); }
          if (target && !busy) { event.preventDefault(); onMove(item.id, target.id); }
        }}
        onPointerDown={event => {
          if (busy || event.button !== 0 || !event.isPrimary || pointer.current) return;
          pointer.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, active: false };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus({ preventScroll: true });
        }}
        onPointerMove={event => {
          const start = pointer.current;
          if (!start || start.pointerId !== event.pointerId) return;
          if (!start.active && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) return;
          start.active = true;
          const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-reorder-id]');
          start.targetId = target?.dataset.reorderPart === item.part && target.dataset.reorderId !== item.id ? target.dataset.reorderId : null;
          const targetId = start.targetId;
          setDrag(current => current?.id === item.id && current.targetId === targetId ? current : { id: item.id, targetId });
          if (event.clientY < 70) window.scrollBy(0, -18);
          else if (event.clientY > window.innerHeight - 70) window.scrollBy(0, 18);
        }}
        onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
        onLostPointerCapture={() => { pointer.current = null; setDrag(null); }}>
        {children}
      </div>
      <div className="reorder-controls">
        <button type="button" aria-label={`Move ${name} earlier`} disabled={busy || !previous} onClick={() => onMove(item.id, previous.id)}><ArrowLeft size={16} aria-hidden="true" /></button>
        <span>{name}</span>
        <button type="button" aria-label={`Move ${name} later`} disabled={busy || !next} onClick={() => onMove(item.id, next.id)}><ArrowRight size={16} aria-hidden="true" /></button>
      </div>
    </div>
  );
}
