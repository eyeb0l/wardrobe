import { useRef, useState } from "react";
import { Copy, UploadSimple } from "@phosphor-icons/react";
import { IMAGE_ACCEPT, prepareUploadImage } from "./image-upload.mjs";
import { modeledDimensionError } from "../shared/modeled-upload.mjs";

export function CopyPrompt({ prompt, className, disabled }) {
  const [copiedPrompt, setCopiedPrompt] = useState(null);
  const [manualCopy, setManualCopy] = useState(false);
  if (!prompt) return null;
  return <>
    <button type="button" className={className} disabled={disabled} onClick={async () => {
      try { await navigator.clipboard.writeText(prompt); setCopiedPrompt(prompt); setManualCopy(false); }
      catch { setManualCopy(true); }
    }}><Copy size={14} aria-hidden="true" />{copiedPrompt === prompt ? "Copied" : "Copy prompt"}</button>
    {manualCopy && <label className="manual-photo-copy">Clipboard unavailable. Select and copy this prompt:<textarea readOnly rows={6} value={prompt} onFocus={(event) => event.target.select()} /></label>}
  </>;
}

export function ModeledPhotoUpload({ kind = "garment", className, disabled, onUpload }) {
  const input = useRef(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  return <div className="manual-photo-upload">
    <input ref={input} type="file" accept={IMAGE_ACCEPT} hidden disabled={disabled || preparing} onChange={async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      setPreparing(true); setError("");
      try {
        const image = await prepareUploadImage(file);
        const dimensionError = modeledDimensionError(image.width, image.height, kind);
        if (dimensionError) throw new Error(dimensionError);
        await onUpload({ imageDataUrl: image.dataUrl });
      } catch (error) { setError(error.message); }
      finally { setPreparing(false); }
    }} />
    <button type="button" className={className} disabled={disabled || preparing} onClick={() => input.current?.click()}><UploadSimple size={16} aria-hidden="true" />{preparing ? "Preparing photo…" : "Upload modeled photo"}</button>
    <p className="manual-photo-help">Have a photo from another model? Upload it for review. {kind === "outfit" ? "Square, at least 512 × 512 pixels." : "Horizontal 3:2, at least 768 × 512 pixels."} Use the same person and garment references.</p>
    {error && <p className="manual-photo-error" role="alert">{error}</p>}
  </div>;
}
