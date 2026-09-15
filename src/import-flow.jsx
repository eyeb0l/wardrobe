import { OptimizedImage } from "./OptimizedImage.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Plus, SpinnerGap, Trash, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import { IMAGE_ACCEPT, formatImageBytes, isImageUpload, prepareUploadImage } from "./image-upload.mjs";
import "./import-flow.css";

const API = "/api/import/jobs";
const CONFIG_API = "/api/import/config";
const PARTS = [
  ["upperbody", "Tops"],
  ["dresses", "Dresses"],
  ["wholebody_up", "Jackets"],
  ["lowerbody", "Bottoms"],
  ["accessories_up", "Accessories"],
  ["shoes", "Shoes"],
];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "The import job could not be updated.");
  return value;
}

function deriveStatus(job) {
  const crop = job.stages?.crop;
  const garment = job.stages?.garment;
  const modeled = job.stages?.modeled;
  if (job.error || crop?.status === "failed" || garment?.status === "failed" || modeled?.status === "failed") return { tone: "error", text: "Import needs attention", detail: crop?.error || garment?.error || modeled?.error || job.error };
  if (modeled?.status === "ready") return { tone: "ready", text: "Choose a reference to regenerate" };
  if (modeled?.status === "review") return { tone: "ready", text: "Modeled image ready for review" };
  if (modeled?.status === "processing") return { tone: "processing", text: "Styling modeled image" };
  if (garment?.status === "review") return { tone: "ready", text: "Ready for review" };
  if (garment?.status === "approved") return { tone: "processing", text: "Creating modeled image" };
  if (crop?.status === "review") return { tone: "ready", text: job.canUseOriginal ? "Product image ready for review" : "Crop ready for review" };
  if (crop?.status === "approved") return { tone: "processing", text: "Creating garment image" };
  if (crop?.status === "rejected" || garment?.status === "rejected" || modeled?.status === "rejected") return { tone: "complete", text: "Import declined" };
  return { tone: "processing", text: "Extracting clothing from image" };
}

function reviewStageFor(job) {
  if (["ready", "review", "failed"].includes(job.stages?.modeled?.status)) return "modeled";
  if (job.stages?.garment?.status === "review") return "garment";
  if (job.stages?.crop?.status === "review") return "crop";
  return null;
}

function hasCleanupFailure(job) {
  return job.stages?.garment?.status === "failed" && Boolean(job.stages?.garment?.failedAssetUrl);
}

function defaultDraft(job) {
  const metadata = job.metadata || {};
  return {
    name: metadata.name || "New piece",
    part: metadata.part || "upperbody",
    color: metadata.color || "#d8d0c2",
    secondaryColor: metadata.secondaryColor || "",
    tags: Array.isArray(metadata.tags) ? metadata.tags.join(", ") : (metadata.tags || ""),
  };
}

function ModelReferencePicker({ references, selected, onSelect, onRefresh, disabled }) {
  return <fieldset className="import-reference-picker" disabled={disabled}>
    <legend>Model reference</legend>
    <div className="import-reference-options">
      {references.map((reference) => <label key={reference.id} className={selected === reference.id ? "is-selected" : ""}>
        <OptimizedImage src={reference.imageUrl} sizes="80px" alt="" />
        <span><input type="radio" name="model-reference" value={reference.id} checked={selected === reference.id} onChange={() => onSelect(reference.id)} />{reference.label}</span>
      </label>)}
    </div>
    {!references.some((reference) => reference.id === selected) && <p className="import-field-error">This reference is unavailable. Choose another photo.</p>}
    <button className="import-reference-refresh" type="button" onClick={onRefresh}>Refresh photos</button>
  </fieldset>;
}

function ReviewEditor({ job, stage, draft, setDraft, regenPrompt, setRegenPrompt, imageChoice, setImageChoice, references, selectedReference, setSelectedReference, refreshReferences, busy, onAction }) {
  const isCrop = stage === "crop";
  const isGarment = stage === "garment";
  const useOriginal = isCrop && job.canUseOriginal && imageChoice === "original";
  const originalGarment = isGarment && job.stages.garment.source === "original";
  const isReady = job.stages[stage]?.status === "ready";
  const isFailed = job.stages[stage]?.status === "failed";
  const referenceChanged = stage === "modeled" && selectedReference !== (job.modelReferenceId || "default");
  const referenceAvailable = references.some((reference) => reference.id === selectedReference);
  const asset = useOriginal ? job.originalAssetUrl : job.stages[stage]?.assetUrl || job.stages.garment.assetUrl;
  const primaryValid = HEX_COLOR.test(draft.color);
  const secondaryValid = !draft.secondaryColor || HEX_COLOR.test(draft.secondaryColor);
  return (
    <div className="import-editor">
      <OptimizedImage className="import-editor__preview" src={asset} alt={useOriginal || originalGarment ? "Original product image" : isCrop ? "Detected item crop" : isGarment ? "Extracted garment" : isFailed && !job.stages[stage]?.assetUrl ? "Garment awaiting modeled image" : "Generated modeled look"} />
      <div className="import-fields">
        <p className="import-editor__stage">{isCrop ? "Detected item" : isGarment ? "Garment image" : "Modeled image"}</p>
        {isCrop ? job.canUseOriginal ? (
          <fieldset className="import-image-choice" disabled={busy}>
            <legend>This looks like a clean product photo</legend>
            <label><input type="radio" name={`image-choice-${job.id}`} value="original" checked={imageChoice === "original"} onChange={() => setImageChoice("original")} /><span><strong>Use original image</strong><small>Keep the uploaded image and its white or transparent background. No garment generation.</small></span></label>
            <label><input type="radio" name={`image-choice-${job.id}`} value="extract" checked={imageChoice === "extract"} onChange={() => setImageChoice("extract")} /><span><strong>Extract garment</strong><small>Generate a clean garment cutout with a transparent background.</small></span></label>
          </fieldset>
        ) : <p className="import-card__detail">Check that this crop contains the complete intended item. Extract garment will generate a clean cutout for review.</p> : isGarment ? (
          <>
            {originalGarment && <p className="import-card__detail">Your original product image is ready. Check its details below. Approving it adds the item and creates a modeled preview.</p>}
            <div className="import-field"><label htmlFor={`name-${job.id}`}>Name</label><input id={`name-${job.id}`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
            <div className="import-field"><label htmlFor={`part-${job.id}`}>Category</label><select id={`part-${job.id}`} value={draft.part} onChange={(event) => setDraft({ ...draft, part: event.target.value })}>{PARTS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>
            <div className="import-field"><label htmlFor={`primary-${job.id}`}>Primary color</label><div className="import-color-row"><input id={`primary-${job.id}`} type="color" value={primaryValid ? draft.color : "#000000"} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><input aria-label="Primary color hex" aria-invalid={!primaryValid} value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></div>{!primaryValid && <small className="import-field-error">Use a six-digit hex color, such as #d8d0c2.</small>}</div>
            <div className="import-field"><label htmlFor={`secondary-${job.id}`}>Secondary color <span>optional</span></label><input id={`secondary-${job.id}`} type="text" aria-invalid={!secondaryValid} placeholder="#hex or leave blank" value={draft.secondaryColor} onChange={(event) => setDraft({ ...draft, secondaryColor: event.target.value })} />{!secondaryValid && <small className="import-field-error">Use a six-digit hex color or leave this empty.</small>}</div>
            <div className="import-field"><label htmlFor={`tags-${job.id}`}>Details</label><input id={`tags-${job.id}`} value={draft.tags} placeholder="casual, cotton, striped" onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></div>
          </>
        ) : <p className="import-card__detail">{isReady ? "Choose a reference and optional direction, then regenerate. Your current shot stays in your wardrobe until you approve its replacement." : isFailed ? "The modeled image could not be created. Check the reference below and retry." : "Approve this editorial image to attach it to the new wardrobe piece, or regenerate it with a different reference or direction."}</p>}
        {!isCrop && <ModelReferencePicker references={references} selected={selectedReference} onSelect={setSelectedReference} onRefresh={refreshReferences} disabled={busy} />}
        {referenceChanged && !isFailed && <p className="import-card__detail">Regenerate to apply this reference to the modeled image.</p>}
        {!isCrop && <div className="import-field import-regenerate-field">
          <label htmlFor={`regenerate-${job.id}-${stage}`}>{originalGarment ? "Extraction direction" : "Regeneration direction"} <span>optional</span></label>
          <textarea id={`regenerate-${job.id}-${stage}`} rows="3" value={regenPrompt} onChange={(event) => setRegenPrompt(event.target.value)} placeholder={isGarment ? "Example: preserve the original zipper and remove the retail tag" : "Example: use a quiet evening street and show the full garment"} />
        </div>}
        <div className="import-actions">
          {!isFailed && !isReady && <button className="import-button" disabled={busy} onClick={() => onAction("reject")}><Trash size={14} /> Reject</button>}
          {!isCrop && <button className="import-button" disabled={busy || (stage === "modeled" && !referenceAvailable)} onClick={() => onAction("regenerate", regenPrompt)}><ArrowCounterClockwise size={14} /> {isFailed ? "Retry" : originalGarment ? "Extract garment" : "Regenerate"}</button>}
          {!isFailed && !isReady && <button className="import-button import-button--primary" disabled={busy || referenceChanged || (isGarment && !referenceAvailable) || (isGarment && (!draft.name.trim() || !primaryValid || !secondaryValid))} onClick={() => onAction(useOriginal ? "use-original" : "approve")}><Check size={14} weight="bold" /> {isCrop ? useOriginal ? "Use original image" : "Extract garment" : "Approve"}</button>}
        </div>
      </div>
    </div>
  );
}

function CleanupEditor({ job, tolerance, setTolerance, busy, onPreview, onAccept }) {
  const stage = job.stages.garment;
  const contaminated = stage.cleanupDiagnostics?.contaminatedPixels;
  const previewTimer = useRef(null);
  useEffect(() => () => clearTimeout(previewTimer.current), []);
  const updateTolerance = (next) => {
    setTolerance(next);
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => onPreview(next), 300);
  };
  return (
    <div className="import-cleanup-editor">
      <p className="import-editor__stage">Background cleanup</p>
      <p className="import-card__detail">The generated garment is preserved below. Adjust the cleanup locally—this does not call the image model again.</p>
      <div className="import-cleanup-comparison">
        <figure><OptimizedImage src={stage.failedAssetUrl} alt="Generated garment on its chroma background" /><figcaption>Generated source</figcaption></figure>
        <figure><OptimizedImage src={stage.cleanupPreviewUrl || stage.failedAssetUrl} alt="Transparent garment cleanup preview" /><figcaption>{stage.cleanupPreviewUrl ? "Cleanup preview" : "Preview appears here"}</figcaption></figure>
      </div>
      <div className="import-field import-cleanup-strength">
        <label htmlFor={`cleanup-${job.id}`}>Cleanup strength <strong>{tolerance}</strong></label>
        <input id={`cleanup-${job.id}`} type="range" min="18" max="110" step="2" value={tolerance} onChange={(event) => updateTolerance(Number(event.target.value))} />
        <div className="import-cleanup-scale"><span>Preserve more edge detail</span><span>Remove more background</span></div>
      </div>
      {Number.isFinite(contaminated) && <p className="import-card__detail">The automated check sees {contaminated.toLocaleString()} tinted edge {contaminated === 1 ? "pixel" : "pixels"}. If the preview looks clean, you can still use it.</p>}
      <div className="import-actions">
        <button className="import-button" disabled={busy} onClick={() => onPreview(tolerance)}><ArrowCounterClockwise size={14} /> Preview cleanup</button>
        <button className="import-button import-button--primary" disabled={busy} onClick={onAccept}><Check size={14} weight="bold" /> Use this cleanup</button>
      </div>
    </div>
  );
}

export function WardrobeImportFlow({ onGarmentApproved, onModeledApproved, regenerationRequest }) {
  const inputRef = useRef(null);
  const uploadPreviews = useRef(new Set());
  const [uploads, setUploads] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [regenerationPrompts, setRegenerationPrompts] = useState({});
  const [imageChoices, setImageChoices] = useState({});
  const [referenceChoices, setReferenceChoices] = useState({});
  const [cleanupTolerances, setCleanupTolerances] = useState({});
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [setup, setSetup] = useState(null);
  const [openingModeled, setOpeningModeled] = useState(false);

  useEffect(() => {
    if (!regenerationRequest) return;
    let cancelled = false;
    setOpen(true); setError(""); setOpeningModeled(true);
    api(`/api/import/wardrobe/${regenerationRequest.id}/modeled`, { method: "POST" })
      .then((job) => {
        if (cancelled) return;
        setJobs((current) => [...current.filter((item) => item.id !== job.id), job]);
        setDrafts((current) => ({ ...current, [job.id]: defaultDraft(job) }));
        setReferenceChoices((current) => ({ ...current, [job.id]: job.modelReferenceId || "default" }));
        setSelectedReviewId(job.id);
      })
      .catch((requestError) => { if (!cancelled) setError(requestError.message); })
      .finally(() => { if (!cancelled) setOpeningModeled(false); });
    return () => { cancelled = true; };
  }, [regenerationRequest]);

  const refreshReferences = useCallback(async () => {
    try { setSetup(await api(CONFIG_API)); }
    catch (requestError) { setError(requestError.message); }
  }, []);
  useEffect(() => { if (open) void refreshReferences(); }, [open, refreshReferences]);

  const uploadLifecycle = useRef(0);
  useEffect(() => () => {
    uploadLifecycle.current += 1;
    uploadPreviews.current.forEach((url) => URL.revokeObjectURL(url));
    uploadPreviews.current.clear();
  }, []);

  useEffect(() => {
    api(CONFIG_API).then(setSetup).catch((requestError) => setSetup({ ready: false, error: requestError.message }));
    api(API)
      .then((storedJobs) => {
        const visibleJobs = storedJobs.filter((job) => job.status !== "complete" && job.stages?.crop?.status !== "rejected" && job.stages?.garment?.status !== "rejected" && job.stages?.modeled?.status !== "rejected");
        setJobs(visibleJobs);
        setDrafts(Object.fromEntries(visibleJobs.map((job) => [job.id, defaultDraft(job)])));
      })
      .catch(() => {});
  }, []);

  const refresh = useCallback(async (id) => {
    try {
      const next = await api(`${API}/${id}`);
      setJobs((current) => current.map((job) => job.id === id ? next : job));
      setDrafts((current) => current[id] ? current : { ...current, [id]: defaultDraft(next) });
    } catch (requestError) { setError(requestError.message); }
  }, []);

  useEffect(() => {
    if (!jobs.some((job) => (job.stages?.crop?.status === "approved" && ["processing", "pending", "queued"].includes(job.stages?.garment?.status)) || ["processing", "queued"].includes(job.stages?.modeled?.status) || (job.stages?.garment?.status === "approved" && job.stages?.modeled?.status === "pending"))) return undefined;
    const timer = setInterval(() => jobs.forEach((job) => refresh(job.id)), 900);
    return () => clearInterval(timer);
  }, [jobs, refresh]);

  const submitFiles = useCallback(async (files) => {
    if (!setup?.ready) { setOpen(true); return; }
    const images = [...files].filter(isImageUpload);
    if (!images.length) return;
    const batch = images.map((file) => {
      const isHeic = /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
      const previewUrl = isHeic ? null : URL.createObjectURL(file);
      if (previewUrl) uploadPreviews.current.add(previewUrl);
      return { id: crypto.randomUUID(), file, name: file.name, previewUrl, status: "Waiting to upload" };
    });
    setUploads((current) => [...current, ...batch]);
    setDragging(false); setError(""); setNotice(null); setOpen(true);
    const lifecycle = uploadLifecycle.current;
    for (const upload of batch) {
      if (lifecycle !== uploadLifecycle.current) break;
      const { file, id } = upload;
      let { previewUrl } = upload;
      try {
        setUploads((current) => current.map((item) => item.id === id ? { ...item, status: "Preparing image" } : item));
        const prepared = await prepareUploadImage(file);
        if (lifecycle !== uploadLifecycle.current) break;
        if (previewUrl) { URL.revokeObjectURL(previewUrl); uploadPreviews.current.delete(previewUrl); }
        previewUrl = URL.createObjectURL(prepared.blob);
        uploadPreviews.current.add(previewUrl);
        const detail = prepared.compressed ? ` · ${formatImageBytes(prepared.originalBytes)} → ${formatImageBytes(prepared.bytes)}` : prepared.converted ? " · HEIC converted" : "";
        const imageDataUrl = prepared.dataUrl;
        setUploads((current) => current.map((item) => item.id === id ? { ...item, previewUrl, status: `Uploading and checking image${detail}` } : item));
        const result = await api(API, { method: "POST", body: JSON.stringify({ imageDataUrl, metadata: { name: file.name.replace(/\.[^.]+$/, "") } }) });
        if (lifecycle !== uploadLifecycle.current) break;
        const createdJobs = result.jobs || [result];
        if (!createdJobs.length && result.noClothingDetected) {
          setNotice({ tone: "complete", text: "No clothing detected", detail: `We couldn’t find a distinct wearable item in ${file.name}. Try a clearer or more tightly framed image.` });
          setOpen(true);
          continue;
        }
        setJobs((current) => [...current, ...createdJobs]);
        setDrafts((current) => ({ ...current, ...Object.fromEntries(createdJobs.map((job) => [job.id, defaultDraft(job)])) }));
      } catch (requestError) { if (lifecycle === uploadLifecycle.current) { setError(`${file.name}: ${requestError.message}`); setOpen(true); } }
      finally {
        if (lifecycle === uploadLifecycle.current) setUploads((current) => current.filter((item) => item.id !== id));
        if (previewUrl) { URL.revokeObjectURL(previewUrl); uploadPreviews.current.delete(previewUrl); }
      }
    }
  }, [setup]);

  useEffect(() => {
    let depth = 0;
    const onDragEnter = (event) => { if (![...event.dataTransfer.types].includes("Files")) return; event.preventDefault(); depth += 1; setDragging(true); };
    const onDragOver = (event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); };
    const onDragLeave = (event) => { event.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const onDrop = (event) => { event.preventDefault(); depth = 0; setDragging(false); submitFiles(event.dataTransfer.files); };
    const onPaste = (event) => {
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
      const files = [...(event.clipboardData?.files || [])];
      if (files.some(isImageUpload)) { event.preventDefault(); submitFiles(files); }
    };
    window.addEventListener("dragenter", onDragEnter); window.addEventListener("dragover", onDragOver); window.addEventListener("dragleave", onDragLeave); window.addEventListener("drop", onDrop); window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("dragenter", onDragEnter); window.removeEventListener("dragover", onDragOver); window.removeEventListener("dragleave", onDragLeave); window.removeEventListener("drop", onDrop); window.removeEventListener("paste", onPaste); };
  }, [submitFiles]);

  const perform = async (job, stage, action, prompt = "") => {
    setBusyId(job.id); setError("");
    const modelReferenceId = referenceChoices[job.id] || job.modelReferenceId || "default";
    try {
      if (stage === "garment" && action === "approve") {
        const draft = drafts[job.id];
        const metadata = { ...draft, secondaryColor: draft.secondaryColor || null, tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean) };
        await api(`${API}/${job.id}/metadata`, { method: "PATCH", body: JSON.stringify({ metadata }) });
        const updated = await api(`${API}/${job.id}/stages/garment/approve`, { method: "POST", body: JSON.stringify({ modelReferenceId }) });
        const garmentPath = `/api/import/library/import-${job.id}-garment.png`;
        onGarmentApproved?.({ id: `import-${job.id}`, ...metadata, image: garmentPath, thumbnail: garmentPath, modeledImage: null, palette: [metadata.color, metadata.secondaryColor].filter(Boolean), importJobId: job.id });
        setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      } else {
        const updated = await api(`${API}/${job.id}/stages/${stage}/${action}`, { method: "POST", body: action === "regenerate" ? JSON.stringify({ prompt, ...(stage === "modeled" ? { modelReferenceId } : {}) }) : undefined });
        const removeFromQueue = action === "reject" || (stage === "modeled" && action === "approve");
        const remainingJobs = removeFromQueue ? jobs.filter((item) => item.id !== job.id) : null;
        setJobs((current) => removeFromQueue ? current.filter((item) => item.id !== job.id) : current.map((item) => item.id === job.id ? updated : item));
        if (removeFromQueue) {
          setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
          setSelectedReviewId(null);
          if (!remainingJobs.length && !uploads.length) setOpen(false);
        }
        if (action === "regenerate") setRegenerationPrompts((current) => ({ ...current, [`${job.id}:${stage}`]: "" }));
        if (stage === "modeled" && action === "approve") onModeledApproved?.(job.id, updated.libraryItem?.modeledImage || `/api/import/library/import-${job.id}-modeled.png`);
      }
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const performCleanup = async (job, action, requestedTolerance) => {
    setBusyId(job.id); setError("");
    try {
      const tolerance = requestedTolerance ?? cleanupTolerances[job.id] ?? job.stages?.garment?.cleanupTolerance ?? 46;
      const updated = await api(`${API}/${job.id}/stages/garment/cleanup-${action}`, { method: "POST", body: JSON.stringify({ tolerance }) });
      setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      setCleanupTolerances((current) => ({ ...current, [job.id]: updated.stages?.garment?.cleanupTolerance ?? tolerance }));
      setSelectedReviewId(job.id);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const deleteJob = async (job) => {
    setBusyId(job.id); setError("");
    try {
      await api(`${API}/${job.id}`, { method: "DELETE" });
      const remaining = jobs.filter((item) => item.id !== job.id);
      setJobs(remaining);
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
      if (selectedReviewId === job.id) setSelectedReviewId(null);
      if (!remaining.length && !uploads.length) setOpen(false);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const active = jobs[jobs.length - 1];
  const setupRequired = setup?.ready === false;
  const jobStatus = active ? deriveStatus(active) : notice;
  const activeStatus = setupRequired ? { tone: "error", text: "Setup required" } : uploads.length ? { tone: "processing", text: uploads.length === 1 ? "Adding image…" : `Adding ${uploads.length} images…` } : error ? { tone: "error", text: "Import needs attention" } : jobStatus;
  const readyCount = jobs.filter((job) => deriveStatus(job).tone === "ready").length;
  const selectedReviewJob = jobs.find((job) => job.id === selectedReviewId && (reviewStageFor(job) || hasCleanupFailure(job)));
  const reviewJob = selectedReviewJob || jobs.find((job) => reviewStageFor(job)) || jobs.find((job) => hasCleanupFailure(job)) || active;
  const reviewStage = reviewJob ? reviewStageFor(reviewJob) : null;
  const progress = 0;
  const hasImportActivity = Boolean(uploads.length || jobs.length || notice || error || setupRequired);

  return (
    <>
      <input ref={inputRef} type="file" accept={IMAGE_ACCEPT} aria-label="Choose wardrobe images" multiple hidden disabled={!setup?.ready} onChange={(event) => { submitFiles(event.target.files); event.target.value = ""; }} />
      <div className="import-drop-overlay" data-active={dragging && !setupRequired} aria-hidden={!dragging || setupRequired}><div className="import-drop-target is-over"><UploadSimple size={34} weight="light" /><h2>Drop clothing images</h2><p>A single garment or a photo of a full outfit works. Your wardrobe stays exactly where you left it.</p></div></div>
      <aside className={`import-tray${hasImportActivity ? " is-expanded" : ""}`} aria-label="Wardrobe imports">
        <button className="import-tray__button" type="button" onClick={() => setupRequired || hasImportActivity ? setOpen(true) : inputRef.current?.click()} aria-label={setupRequired ? "Open setup instructions" : hasImportActivity ? "Open import progress" : "Add clothes"}>{activeStatus?.tone === "processing" ? <SpinnerGap size={19} className="import-spinner" /> : activeStatus?.tone === "error" ? <WarningCircle size={19} /> : readyCount ? <span>{readyCount}</span> : notice ? <X size={18} /> : <Plus size={19} />}</button>
        <div className="import-tray__actions">{(uploads[0]?.previewUrl || (!uploads.length && active)) && <OptimizedImage className="import-tray__preview" sizes="80px" src={uploads[0]?.previewUrl || active?.stages?.garment?.assetUrl || active?.stages?.garment?.failedAssetUrl || active?.stages?.crop?.assetUrl || active?.originalAssetUrl} alt="" />}<span className="import-tray__label" role="status">{activeStatus?.text || "Add clothes"}</span>{!setupRequired && <button className="import-icon-button" type="button" onClick={() => inputRef.current?.click()} aria-label="Choose images"><UploadSimple size={17} /></button>}</div>
      </aside>
      <div className="import-popover-backdrop" data-open={open} onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
        <section className="import-popover" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <header className="import-popover__header"><div><p className="import-popover__eyebrow">{reviewJob?.modeledReplacement ? "Modelled shot" : "Wardrobe import"}</p><h2 className="import-popover__title" id="import-title">{uploads.length ? activeStatus.text : readyCount ? `${readyCount} ready for review` : activeStatus?.tone === "error" ? "Import needs attention" : jobs.length ? "Preparing new pieces" : notice?.text || "Add to your wardrobe"}</h2></div><button className="import-icon-button" type="button" onClick={() => setOpen(false)} aria-label="Close import progress"><X size={20} /></button></header>
          {uploads.length > 0 && <div className="import-upload-list" aria-label="Images being added" aria-busy="true">
            {uploads.map((upload) => <div className="import-upload" key={upload.id}>
              {upload.previewUrl ? <OptimizedImage className="import-upload__preview" src={upload.previewUrl} alt="" /> : <div className="import-upload__preview" aria-hidden="true" />}
              <div className="import-upload__body"><p className="import-upload__name" title={upload.name}>{upload.name}</p><p className="import-card__detail" role="status">{upload.status}</p><div className="import-progress is-indeterminate" aria-hidden="true"><div className="import-progress__track"><div className="import-progress__bar" /></div></div></div>
              <SpinnerGap size={20} className="import-spinner" aria-hidden="true" />
            </div>)}
          </div>}
          {openingModeled && <p className="import-card__detail" role="status"><SpinnerGap size={16} className="import-spinner" /> Opening modelled shot…</p>}
          {openingModeled ? null : !jobs.length ? uploads.length ? null : setupRequired ? <div className="import-drop-target import-setup-warning"><WarningCircle size={30} /><h2>Setup required</h2><p>Add your OpenAI API key to <code>.env</code> and a PNG reference photo of yourself at <code>{setup.modelReference || "data/model-reference.png"}</code>, then restart the app.</p></div> : <div className="import-drop-target"><UploadSimple size={28} /><h2>{notice || error ? "Try another image" : "Choose or paste an image"}</h2><p>{notice?.detail || "We’ll isolate each clothing item, suggest its details, and hold everything for your approval."}</p><button className="import-button import-button--primary" disabled={!setup?.ready} onClick={() => { setNotice(null); inputRef.current?.click(); }}>Choose images</button></div> : (
            <>
              <div className={`import-progress${jobStatus?.tone !== "processing" ? " is-reviewing" : progress < 100 ? " is-indeterminate" : ""}`}><div className="import-progress__meta"><span>{jobStatus?.text}</span><span>{jobs.length} {jobs.length === 1 ? "item" : "items"}</span></div>{jobStatus?.tone === "processing" && <div className="import-progress__track"><div className="import-progress__bar" style={{ "--import-progress": `${progress}%` }} /></div>}</div>
              {reviewJob && reviewStage ? <ReviewEditor job={reviewJob} stage={reviewStage} references={setup?.modelReferences || []} selectedReference={referenceChoices[reviewJob.id] || reviewJob.modelReferenceId || "default"} setSelectedReference={(id) => setReferenceChoices((current) => ({ ...current, [reviewJob.id]: id }))} refreshReferences={refreshReferences} imageChoice={imageChoices[reviewJob.id] || (reviewJob.canUseOriginal ? "original" : "extract")} setImageChoice={(choice) => setImageChoices((current) => ({ ...current, [reviewJob.id]: choice }))} draft={drafts[reviewJob.id] || defaultDraft(reviewJob)} setDraft={(draft) => setDrafts((current) => ({ ...current, [reviewJob.id]: draft }))} regenPrompt={regenerationPrompts[`${reviewJob.id}:${reviewStage}`] || ""} setRegenPrompt={(prompt) => setRegenerationPrompts((current) => ({ ...current, [`${reviewJob.id}:${reviewStage}`]: prompt }))} busy={busyId === reviewJob.id} onAction={(action, prompt) => perform(reviewJob, reviewStage, action, prompt)} /> : reviewJob && hasCleanupFailure(reviewJob) ? <CleanupEditor job={reviewJob} tolerance={cleanupTolerances[reviewJob.id] ?? reviewJob.stages.garment.cleanupTolerance ?? 46} setTolerance={(tolerance) => setCleanupTolerances((current) => ({ ...current, [reviewJob.id]: tolerance }))} busy={busyId === reviewJob.id} onPreview={(tolerance) => performCleanup(reviewJob, "preview", tolerance)} onAccept={() => performCleanup(reviewJob, "accept")} /> : null}
              <div className="import-card-list">{jobs.map((job) => { const status = deriveStatus(job); const itemName = drafts[job.id]?.name || job.metadata?.name || "New piece"; const failedStage = job.stages?.garment?.status === "failed" ? "garment" : job.stages?.modeled?.status === "failed" ? "modeled" : null; return <article className={`import-card is-${status.tone}${reviewJob?.id === job.id ? " is-selected" : ""}`} key={job.id}><OptimizedImage className="import-card__image" sizes="96px" src={job.stages?.garment?.assetUrl || job.stages?.garment?.failedAssetUrl || job.stages?.crop?.assetUrl || job.originalAssetUrl} alt="" /><div className="import-card__body"><h3 className="import-card__title">{itemName}</h3><p className="import-card__detail import-card__detail--status" data-tone={status.tone}>{status.tone === "error" ? status.detail : status.text}</p></div><div className="import-card__actions">{status.tone === "ready" && <button className="import-icon-button" onClick={() => { setSelectedReviewId(job.id); setOpen(true); }} aria-label={`Review ${itemName}`}><Check size={17} /></button>}{failedStage && <button className="import-button import-card__retry" disabled={busyId === job.id} onClick={() => perform(job, failedStage, "regenerate", "")}><ArrowCounterClockwise size={14} /> Retry</button>}<button className="import-icon-button import-card__delete" disabled={busyId === job.id} onClick={() => deleteJob(job)} aria-label={`Delete ${itemName} from import queue`}><Trash size={16} /></button></div></article>; })}</div>
              <div className="import-actions"><button className="import-button" onClick={() => inputRef.current?.click()}><Plus size={14} /> Add another</button></div>
            </>
          )}
          {error && <p className="import-status is-error" role="alert">{error}</p>}
        </section>
      </div>
    </>
  );
}
