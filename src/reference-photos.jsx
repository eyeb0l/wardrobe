import { useEffect, useRef, useState } from "react";
import { ImageSquare, Plus, SpinnerGap, UploadSimple } from "@phosphor-icons/react";
import { IMAGE_ACCEPT, prepareUploadImage } from "./image-upload.mjs";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { uiErrorMessage } from "./ui-error.mjs";

const API = "/api/import/model-references";

// Replace or add the identity photos used for modelled images. Nothing is
// saved until the person compares the new photo and confirms it.
export function ReferencePhotos({ config, onChange, disabled = false }) {
  const input = useRef(null);
  const [target, setTarget] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const references = config?.modelReferences || [];
  const hasDefault = references.some((reference) => reference.id === "default");

  useEffect(() => () => { if (pending) URL.revokeObjectURL(pending.previewUrl); }, [pending]);

  function choose(reference) {
    setTarget(reference);
    setError("");
    setNotice("");
    if (input.current) { input.current.value = ""; input.current.click(); }
  }

  async function prepare(file) {
    if (!file) return;
    setBusy(true);
    try {
      const image = await prepareUploadImage(file);
      if (Math.min(image.width, image.height) < 512) throw new Error("Choose a reference photo at least 512 pixels on its shorter side.");
      setPending({ ...image, previewUrl: URL.createObjectURL(image.blob), reference: target });
    } catch (prepareError) { setError(prepareError.message); }
    finally { setBusy(false); }
  }

  async function save() {
    const { reference, dataUrl } = pending;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(reference ? `${API}/${reference.id}` : API, {
        method: reference ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageDataUrl: dataUrl, ...(reference?.imageUrl ? { previousImageUrl: reference.imageUrl } : {}) }),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) {
        // Another device changed the photos: show the current ones so the
        // next confirmation is made against what is actually saved.
        if (response.status === 409) {
          const latest = await fetch("/api/import/config", { cache: "no-store" }).then((result) => result.ok ? result.json() : null).catch(() => null);
          if (latest) { onChange(latest); setPending(null); }
        }
        throw new Error(uiErrorMessage(value.error, "The reference photo couldn’t be saved. Please try again."));
      }
      onChange(value);
      const label = reference?.label || value.modelReferences?.find((item) => item.id === value.createdReferenceId)?.label || "New reference";
      const name = label === "Default" ? "Default reference" : label;
      setNotice(reference?.imageUrl ? `${name} replaced. New imports and outfits will use this photo.` : `${name} added.`);
      setPending(null);
    } catch (saveError) { setError(saveError.message); }
    finally { setBusy(false); }
  }

  const locked = disabled || busy;
  const defaultSlot = { id: "default", label: "Default" };
  return <section className="reference-photos" aria-labelledby="reference-photos-title" aria-busy={busy}>
    <div className="reference-photos__heading">
      <ImageSquare size={22} weight="light" aria-hidden="true" />
      <div>
        <h3 id="reference-photos-title">{hasDefault ? "Reference photos" : "One photo before your first import"}</h3>
        <p>{hasDefault ? "Modelled photos and outfits are created from these photos of you. Replace one any time; photos you’ve already saved stay as they are." : "Add a clear, well-lit photo of yourself. It’s needed for imports and modelled looks. You can browse now and add it later."}</p>
      </div>
    </div>
    <input ref={input} type="file" accept={IMAGE_ACCEPT} hidden onChange={(event) => void prepare(event.target.files?.[0])} />
    {pending ? <div className="reference-photos__confirm">
      <div className="reference-photos__compare">
        {pending.reference?.imageUrl && <figure><OptimizedImage src={pending.reference.imageUrl} sizes="160px" alt={`Current ${pending.reference.label} reference`} /><figcaption>Current</figcaption></figure>}
        <figure><img src={pending.previewUrl} alt="New reference photo" /><figcaption>New</figcaption></figure>
      </div>
      <p>{pending.reference?.imageUrl ? `Replace the ${pending.reference.label} reference with this photo? New imports, retries and outfits that use it will use the new photo.` : pending.reference ? "Use this photo as your default reference?" : "Add this photo as another reference?"}</p>
      <div className="reference-photos__actions">
        <button type="button" className="setup-primary" disabled={locked} onClick={save}>{busy ? <><SpinnerGap size={15} className="reference-photos__spinner" aria-hidden="true" /> Saving…</> : pending.reference?.imageUrl ? "Replace photo" : "Save photo"}</button>
        <button type="button" className="setup-text-button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
      </div>
    </div> : <>
      {references.length > 0 && <ul className="reference-photos__list">
        {references.map((reference) => <li key={reference.id}>
          <OptimizedImage src={reference.imageUrl} sizes="96px" alt={`${reference.label} reference`} />
          <span>{reference.label}</span>
          {reference.editable && <button type="button" className="setup-text-button" disabled={locked} aria-label={`Replace ${reference.label} reference`} onClick={() => choose(reference)}>Replace</button>}
        </li>)}
      </ul>}
      <div className="reference-photos__actions">
        {!hasDefault && config?.canSetDefaultReference && <button type="button" className="setup-primary" disabled={locked} onClick={() => choose(defaultSlot)}><UploadSimple size={16} aria-hidden="true" /> Choose a photo</button>}
        {hasDefault && <button type="button" className="setup-text-button reference-photos__add" disabled={locked} onClick={() => choose(null)}><Plus size={13} aria-hidden="true" /> Add another photo</button>}
        {busy && <span className="reference-photos__status" role="status">Preparing photo…</span>}
      </div>
    </>}
    {error && <p className="setup-feedback setup-feedback--error" role="alert">{error}</p>}
    {notice && <p className="setup-feedback" role="status">{notice}</p>}
  </section>;
}
