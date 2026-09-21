import { useEffect, useRef, useState } from "react";
import { Copy, UploadSimple } from "@phosphor-icons/react";
import { IMAGE_ACCEPT } from "./image-upload.mjs";
import { modeledCrop } from "./modeled-crop.mjs";
import { encodeModeledCrop, loadCropPhoto } from "./modeled-crop-image.mjs";
import { uiErrorMessage } from "./ui-error.mjs";

export function CopyPrompt({ prompt, className, disabled }) {
  const [copiedPrompt, setCopiedPrompt] = useState(null);
  const [manualCopy, setManualCopy] = useState(false);
  if (!prompt) return null;
  return <>
    <button type="button" className={className} disabled={disabled} onClick={async () => {
      try { await navigator.clipboard.writeText(prompt); setCopiedPrompt(prompt); setManualCopy(false); }
      catch { setManualCopy(true); }
    }}><Copy size={14} aria-hidden="true" />{copiedPrompt === prompt ? "Copied" : "Copy prompt"}</button>
    {manualCopy && <label className="manual-photo-copy">Select and copy the prompt below:<textarea readOnly rows={6} value={prompt} onFocus={(event) => event.target.select()} /></label>}
  </>;
}

const centered = () => ({ zoom: 1, x: 0.5, y: 0.5 });
const clampPosition = (value) => Math.max(0, Math.min(1, value));

export function ModeledPhotoUpload({ kind = "garment", className, disabled, onUpload, onEditingChange }) {
  const input = useRef(null);
  const currentPhoto = useRef(null);
  const lifecycle = useRef(0);
  const drag = useRef(null);
  const [photo, setPhoto] = useState(null);
  const [framing, setFraming] = useState(centered);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => { lifecycle.current++; currentPhoto.current?.close(); currentPhoto.current = null; }, []);
  useEffect(() => {
    onEditingChange?.(Boolean(photo) || preparing);
    return () => onEditingChange?.(false);
  }, [photo, preparing, onEditingChange]);
  const busy = disabled || preparing;
  const crop = photo ? modeledCrop(photo.width, photo.height, kind, framing) : null;
  const clearPhoto = () => {
    currentPhoto.current?.close(); currentPhoto.current = null;
    setPhoto(null); setFraming(centered()); setError(""); drag.current = null;
  };
  const upload = async () => {
    const token = lifecycle.current;
    setPreparing(true); setError("");
    try {
      const image = await encodeModeledCrop(photo, kind, framing);
      if (token !== lifecycle.current) return;
      const result = await onUpload(image);
      if (token === lifecycle.current && result !== false) clearPhoto();
    } catch (error) { if (token === lifecycle.current) setError(error.message); }
    finally { if (token === lifecycle.current) setPreparing(false); }
  };
  return <div className="manual-photo-upload">
    <input ref={input} type="file" accept={IMAGE_ACCEPT} hidden disabled={busy} onChange={async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      const token = lifecycle.current;
      setPreparing(true); setError("");
      try {
        const loaded = await loadCropPhoto(file, kind);
        if (token !== lifecycle.current) { loaded.close(); return; }
        currentPhoto.current?.close(); currentPhoto.current = loaded;
        setPhoto(loaded); setFraming(centered());
      } catch (error) { if (token === lifecycle.current) setError(error.message); }
      finally { if (token === lifecycle.current) setPreparing(false); }
    }} />
    {photo ? <div className="modeled-crop">
      <p className="modeled-crop-title">Frame your modelled photo</p>
      <p className="manual-photo-help">Drag the photo or use the controls to keep the person and clothing in view.</p>
      <div className="modeled-crop-frame" role="group" aria-label="Photo crop. Drag to reposition, or use arrow keys." tabIndex={busy ? -1 : 0}
        style={{ aspectRatio: kind === "outfit" ? "1" : "3 / 2" }}
        onPointerDown={(event) => {
          if (busy || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const rect = event.currentTarget.getBoundingClientRect();
          drag.current = { id: event.pointerId, px: event.clientX, py: event.clientY, x: framing.x, y: framing.y, scale: crop.width / rect.width };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (busy || !start || start.id !== event.pointerId) return;
          setFraming((current) => ({ ...current,
            x: photo.width - crop.width > 0.001 ? clampPosition(start.x - (event.clientX - start.px) * start.scale / (photo.width - crop.width)) : 0.5,
            y: photo.height - crop.height > 0.001 ? clampPosition(start.y - (event.clientY - start.py) * start.scale / (photo.height - crop.height)) : 0.5,
          }));
        }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={(event) => {
          if (busy || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          const axis = ["ArrowLeft", "ArrowRight"].includes(event.key) ? "x" : "y";
          const change = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -0.02 : 0.02;
          setFraming((current) => ({ ...current, [axis]: clampPosition(current[axis] + change) }));
        }}>
        <img src={photo.url} alt="Preview of the cropped modelled photo" draggable={false} style={{ width: `${photo.width / crop.width * 100}%`, height: `${photo.height / crop.height * 100}%`, left: `${-crop.x / crop.width * 100}%`, top: `${-crop.y / crop.height * 100}%` }} />
        <div className="modeled-crop-grid" aria-hidden="true" />
      </div>
      <label className="modeled-crop-control">Zoom<input type="range" min="1" max={crop.maxZoom} step="0.01" value={framing.zoom} disabled={busy || crop.maxZoom <= 1} onChange={(event) => setFraming((current) => ({ ...current, zoom: Number(event.target.value) }))} /></label>
      <label className="modeled-crop-control">Horizontal position<input type="range" min="0" max="1" step="0.01" value={framing.x} disabled={busy || photo.width - crop.width < 0.001} onChange={(event) => setFraming((current) => ({ ...current, x: Number(event.target.value) }))} /></label>
      <label className="modeled-crop-control">Vertical position<input type="range" min="0" max="1" step="0.01" value={framing.y} disabled={busy || photo.height - crop.height < 0.001} onChange={(event) => setFraming((current) => ({ ...current, y: Number(event.target.value) }))} /></label>
      <div className="modeled-crop-actions">
        <button type="button" className={className} disabled={busy} onClick={() => setFraming(centered())}>Reset crop</button>
        <button type="button" className={className} disabled={busy} onClick={clearPhoto}>Cancel crop</button>
        <button type="button" className={className} disabled={busy} onClick={upload}><UploadSimple size={16} aria-hidden="true" />{preparing ? "Preparing photo…" : "Upload for review"}</button>
      </div>
    </div> : null}
    <button type="button" className={className} disabled={busy} onClick={() => input.current?.click()}><UploadSimple size={16} aria-hidden="true" />{preparing ? "Preparing photo…" : photo ? "Choose another photo" : "Upload modelled photo"}</button>
    {!photo && <p className="manual-photo-help">Have a modelled photo you made elsewhere? Use the same person and clothing as the references. You’ll review the photo before saving it.</p>}
    {error && <p className="manual-photo-error" role="alert">{uiErrorMessage(error)}</p>}
  </div>;
}
