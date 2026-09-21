import { prepareOriginalCutout } from "./background-removal.mjs";
import { CopyPrompt, ModeledPhotoUpload } from "./modeled-photo-controls.jsx";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Plus, SpinnerGap, Trash, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import { IMAGE_ACCEPT, formatImageBytes, isImageUpload, prepareUploadImage } from "./image-upload.mjs";
import { activeImportJobIds } from "./import-polling.mjs";
import { isDetectionRetryRunning } from "./detection-retry.mjs";
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
  if (isDetectionRetryRunning(job)) return { tone: "processing", text: "Checking with Terra…" };
  if (job.detectionRetry?.status === "review") return { tone: "ready", text: "Terra detection ready for review" };
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

function DetectionRetryReview({ job, busy, checking, onAction }) {
  const retry = job.detectionRetry;
  const candidates = retry?.candidates || [];
  const [selectedId, setSelectedId] = useState("");
  useEffect(() => setSelectedId(""), [retry?.id]);
  if (retry?.status === "review") return <div className="import-detection-retry">
    <fieldset className="import-detection-candidates" disabled={busy}>
      <legend>Terra found {candidates.length} {candidates.length === 1 ? "item" : "items"}</legend>
      <p className="import-card__detail">{candidates.length ? "Choose the intended item for this import. Your current crop stays visible until you use a result." : "No distinct wearable item was found. You can keep your current crop."}</p>
      <div className="import-detection-options">{candidates.map((candidate) => <label key={candidate.id} className={selectedId === candidate.id ? "is-selected" : ""}>
        <OptimizedImage src={candidate.assetUrl} sizes="120px" alt={candidate.metadata?.name || "Detected item"} />
        <span><input type="radio" name={`detection-${job.id}`} value={candidate.id} checked={selectedId === candidate.id} onChange={() => setSelectedId(candidate.id)} />{candidate.metadata?.name || "Detected item"}</span>
      </label>)}</div>
    </fieldset>
    <div className="import-actions">
      <button className="import-button" disabled={busy} onClick={() => onAction("discard", { retryId: retry.id })}>Keep current crop</button>
      {candidates.length > 0 && <button className="import-button import-button--primary" disabled={busy || !candidates.some((candidate) => candidate.id === selectedId)} onClick={() => onAction("accept", { retryId: retry.id, candidateId: selectedId })}>Use selected item</button>}
    </div>
  </div>;
  return <div className="import-detection-retry">
    <button className="import-button" disabled={busy || checking} onClick={() => onAction("retry", { requestId: crypto.randomUUID() })}>{checking ? <SpinnerGap size={14} className="import-spinner" /> : <ArrowCounterClockwise size={14} />} {checking ? "Checking with Terra…" : "Retry with Terra"}</button>
    <p className="import-card__detail" role={checking ? "status" : undefined}>{checking ? "Your current crop is kept while Terra checks the original image." : "For missed items or incomplete crops. Uses paid API credits; you review the result before applying it."}</p>
    {job.detectionRetryAttempt?.status === "started" && !checking && <p className="import-field-error">The previous check may have been interrupted. Your current crop is kept. You can retry explicitly.</p>}
    {job.detectionRetryAttempt?.status === "failed" && <p className="import-field-error">{job.detectionRetryAttempt.error || "Terra could not finish. Your current crop is unchanged."}</p>}
  </div>;
}

function ReviewEditor({ job, stage, draft, setDraft, regenPrompt, setRegenPrompt, imageChoice, setImageChoice, references, selectedReference, setSelectedReference, refreshReferences, busy, detectionBusy, onDetectionAction, onAction, onUpload }) {
  const [cropping, setCropping] = useState(false);
  const isCrop = stage === "crop";
  const detectionChecking = detectionBusy || isDetectionRetryRunning(job);
  const detectionReview = isCrop && job.detectionRetry?.status === "review";
  const decisionBusy = busy || detectionChecking || detectionReview;
  const isGarment = stage === "garment";
  const useOriginal = isCrop && imageChoice === "original";
  const originalGarment = isGarment && job.stages.garment.source === "original";
  const isReady = job.stages[stage]?.status === "ready";
  const isFailed = job.stages[stage]?.status === "failed";
  const referenceChanged = stage === "modeled" && job.stages.modeled.source !== "uploaded" && selectedReference !== (job.modelReferenceId || "default");
  const referenceAvailable = references.some((reference) => reference.id === selectedReference);
  const asset = useOriginal ? job.originalAssetUrl : job.stages[stage]?.assetUrl || job.stages.garment.assetUrl;
  const primaryValid = HEX_COLOR.test(draft.color);
  const secondaryValid = !draft.secondaryColor || HEX_COLOR.test(draft.secondaryColor);
  return (
    <div className="import-editor">
      <OptimizedImage className={`import-editor__preview${useOriginal || originalGarment ? " has-transparency" : ""}`} src={asset} alt={useOriginal || originalGarment ? "Original product image" : isCrop ? "Detected item crop" : isGarment ? "Extracted garment" : isFailed && !job.stages[stage]?.assetUrl ? "Garment awaiting modeled image" : "Generated modeled look"} />
      <div className="import-fields">
        <p className="import-editor__stage">{isCrop ? "Detected item" : isGarment ? "Garment image" : "Modeled image"}</p>
        {isCrop ? (
          <fieldset className="import-image-choice" disabled={decisionBusy || cropping}>
            <legend>{job.canUseOriginal ? "This looks like a clean product photo" : "How would you like to prepare this item?"}</legend>
            <label><input type="radio" name={`image-choice-${job.id}`} value="original" checked={imageChoice === "original"} onChange={() => setImageChoice("original")} /><span><strong>Use original image</strong><small>Keep the photographed item. Remove its background on this device if needed; preserve existing transparency.</small></span></label>
            <label><input type="radio" name={`image-choice-${job.id}`} value="extract" checked={imageChoice === "extract"} onChange={() => setImageChoice("extract")} /><span><strong>Extract garment</strong><small>Generate a clean garment cutout with a transparent background.</small></span></label>
            {!job.canUseOriginal && imageChoice === "original" && <p className="import-card__detail">Use this only when the full original shows one isolated item, without a person or other products. Check the cutout before approving.</p>}
          </fieldset>
        ) : isGarment ? (
          <>
            {originalGarment && <p className="import-card__detail">Your original item is ready on a transparent background. Check the edges and details below. Approving it adds the item and creates a modeled preview.</p>}
            <div className="import-field"><label htmlFor={`name-${job.id}`}>Name</label><input id={`name-${job.id}`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
            <div className="import-field"><label htmlFor={`part-${job.id}`}>Category</label><select id={`part-${job.id}`} value={draft.part} onChange={(event) => setDraft({ ...draft, part: event.target.value })}>{PARTS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>
            <div className="import-field"><label htmlFor={`primary-${job.id}`}>Primary color</label><div className="import-color-row"><input id={`primary-${job.id}`} type="color" value={primaryValid ? draft.color : "#000000"} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><input aria-label="Primary color hex" aria-invalid={!primaryValid} value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></div>{!primaryValid && <small className="import-field-error">Use a six-digit hex color, such as #d8d0c2.</small>}</div>
            <div className="import-field"><label htmlFor={`secondary-${job.id}`}>Secondary color <span>optional</span></label><input id={`secondary-${job.id}`} type="text" aria-invalid={!secondaryValid} placeholder="#hex or leave blank" value={draft.secondaryColor} onChange={(event) => setDraft({ ...draft, secondaryColor: event.target.value })} />{!secondaryValid && <small className="import-field-error">Use a six-digit hex color or leave this empty.</small>}</div>
            <div className="import-field"><label htmlFor={`tags-${job.id}`}>Details</label><input id={`tags-${job.id}`} value={draft.tags} placeholder="casual, cotton, striped" onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></div>
          </>
        ) : <p className="import-card__detail">{isReady ? "Choose a reference and optional direction, then regenerate. Your current shot stays in your wardrobe until you approve its replacement." : isFailed ? "The modeled image could not be created. Retry, or upload a photo you created elsewhere." : "Approve this editorial image to attach it to the new wardrobe piece, or regenerate it with a different reference or direction."}</p>}
        {!isCrop && <ModelReferencePicker references={references} selected={selectedReference} onSelect={setSelectedReference} onRefresh={refreshReferences} disabled={decisionBusy || cropping} />}
        {referenceChanged && !isFailed && <p className="import-card__detail">Regenerate to apply this reference to the modeled image.</p>}
        {!isCrop && <div className="import-field import-regenerate-field">
          <label htmlFor={`regenerate-${job.id}-${stage}`}>{originalGarment ? "Extraction direction" : "Regeneration direction"} <span>optional</span></label>
          <textarea id={`regenerate-${job.id}-${stage}`} rows="3" value={regenPrompt} onChange={(event) => setRegenPrompt(event.target.value)} placeholder={isGarment ? "Example: preserve the original zipper and remove the retail tag" : "Example: use a quiet evening street and show the full garment"} />
        </div>}
        {isCrop && !job.modeledReplacement && job.stages?.garment?.status === "pending" && <DetectionRetryReview job={job} busy={busy} checking={detectionChecking} onAction={onDetectionAction} />}
        <div className="import-actions">
          {!isFailed && !isReady && <button className="import-button" disabled={decisionBusy || cropping} onClick={() => onAction("reject")}><Trash size={14} /> Reject</button>}
          {!isCrop && <button className="import-button" disabled={decisionBusy || cropping || (stage === "modeled" && !referenceAvailable)} onClick={() => onAction("regenerate", regenPrompt)}><ArrowCounterClockwise size={14} /> {isFailed ? "Retry" : originalGarment ? "Extract garment" : "Regenerate"}</button>}
          {isFailed && <CopyPrompt prompt={job.stages[stage]?.generationPrompt} className="import-button" disabled={decisionBusy || cropping} />}
          {!isFailed && !isReady && <button className="import-button import-button--primary" disabled={decisionBusy || cropping || referenceChanged || (isGarment && !referenceAvailable) || (isGarment && (!draft.name.trim() || !primaryValid || !secondaryValid))} onClick={() => onAction(useOriginal ? "use-original" : "approve")}><Check size={14} weight="bold" /> {isCrop ? useOriginal ? "Use original image" : "Extract garment" : "Approve"}</button>}
        </div>
        {stage === "modeled" && <ModeledPhotoUpload key={job.id} className="import-button" disabled={busy} onUpload={onUpload} onEditingChange={setCropping} />}
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
  const [cutoutProgress, setCutoutProgress] = useState("");
  const cutoutController = useRef(null);
  useEffect(() => () => cutoutController.current?.abort(), []);
  const [detectionBusyId, setDetectionBusyId] = useState(null);
  const [, updateDetectionClock] = useState(0);
  const mutationRef = useRef(false);
  const uploadingRef = useRef(0);
  const readVersion = useRef(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [setup, setSetup] = useState(null);
  const [openingModeled, setOpeningModeled] = useState(false);
  const hasStartedDetection = jobs.some((job) => isDetectionRetryRunning(job));
  useEffect(() => {
    if (!hasStartedDetection) return undefined;
    const timer = setInterval(() => updateDetectionClock((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [hasStartedDetection]);

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
    const version = readVersion.current;
    api(API)
      .then((storedJobs) => {
        if (version !== readVersion.current || mutationRef.current) return;
        const visibleJobs = storedJobs.filter((job) => job.status !== "complete" && job.stages?.crop?.status !== "rejected" && job.stages?.garment?.status !== "rejected" && job.stages?.modeled?.status !== "rejected");
        setJobs(visibleJobs);
        setDrafts(Object.fromEntries(visibleJobs.map((job) => [job.id, defaultDraft(job)])));
      })
      .catch(() => {});
  }, []);

  const refresh = useCallback(async (id, signal) => {
    try {
      const version = readVersion.current;
      const next = await api(`${API}/${id}`, { signal });
      if (signal.aborted || mutationRef.current || version !== readVersion.current) return;
      setJobs((current) => current.map((job) => job.id === id ? next : job));
      setDrafts((current) => current[id] ? current : { ...current, [id]: defaultDraft(next) });
    } catch (requestError) { if (!signal.aborted) setError(requestError.message); }
  }, []);

  // Keep the timer stable across progress updates, but cancel stale reads when
  // a job enters review or a user action takes ownership of it.
  const pollingIds = JSON.stringify(busyId ? [] : [...new Set([...activeImportJobIds(jobs), ...jobs.filter((job) => isDetectionRetryRunning(job)).map((job) => job.id)])]);
  useEffect(() => {
    const ids = JSON.parse(pollingIds);
    if (!ids.length) return undefined;
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      await Promise.all(ids.map((id) => refresh(id, controller.signal)));
      // Schedule after completion so a slow request cannot overlap itself.
      if (!controller.signal.aborted) timer = setTimeout(poll, 900);
    };
    timer = setTimeout(poll, 900);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pollingIds, refresh]);

  const submitFiles = useCallback(async (files) => {
    if (mutationRef.current) return;
    if (!setup?.ready) { setOpen(true); return; }
    const images = [...files].filter(isImageUpload);
    if (!images.length) return;
    const batch = images.map((file) => {
      const isHeic = /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
      const previewUrl = isHeic ? null : URL.createObjectURL(file);
      if (previewUrl) uploadPreviews.current.add(previewUrl);
      return { id: crypto.randomUUID(), file, name: file.name, previewUrl, status: "Waiting to upload" };
    });
    uploadingRef.current += 1;
    readVersion.current += 1;
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
          setNotice({ tone: "complete", text: "No clothing detected", detail: `We couldn’t find a distinct wearable item in ${file.name}. Try Terra or choose a clearer image.`, imageDataUrl, metadata: { name: file.name.replace(/\.[^.]+$/, "") } });
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
    uploadingRef.current -= 1;
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

  const beginMutation = (id) => {
    if (mutationRef.current || uploadingRef.current) return false;
    mutationRef.current = true;
    readVersion.current += 1;
    setBusyId(id); setError("");
    return true;
  };
  const endMutation = () => { mutationRef.current = false; setBusyId(null); };

  const performDetection = async (job, action, body) => {
    if (!beginMutation(job.id)) return;
    if (action === "retry") setDetectionBusyId(job.id);
    try {
      const updated = await api(`${API}/${job.id}/detection/${action}`, { method: "POST", body: JSON.stringify(body) });
      setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      if (action === "accept") {
        setDrafts((current) => ({ ...current, [job.id]: defaultDraft(updated) }));
        setImageChoices((current) => ({ ...current, [job.id]: updated.canUseOriginal ? "original" : "extract" }));
      }
      setSelectedReviewId(job.id);
    } catch (requestError) { setError(requestError.message); }
    finally { setDetectionBusyId(null); endMutation(); }
  };

  const retryUndetected = async () => {
    if (!notice?.imageDataUrl || !beginMutation("undetected")) return;
    setDetectionBusyId("undetected");
    try {
      const result = await api(API, { method: "POST", body: JSON.stringify({ imageDataUrl: notice.imageDataUrl, metadata: notice.metadata, detectionModel: "terra" }) });
      const createdJobs = result.jobs || [result];
      if (!createdJobs.length && result.noClothingDetected) {
        setNotice((current) => ({ ...current, detail: "Terra couldn’t find a distinct wearable item either. Try a clearer image, or retry if you want another check." }));
      } else {
        setJobs((current) => [...current, ...createdJobs]);
        setDrafts((current) => ({ ...current, ...Object.fromEntries(createdJobs.map((job) => [job.id, defaultDraft(job)])) }));
        setSelectedReviewId(createdJobs[0]?.id || null);
        setNotice(null);
      }
    } catch (requestError) { setError(requestError.message); }
    finally { setDetectionBusyId(null); endMutation(); }
  };

  const perform = async (job, stage, action, prompt = "") => {
    if (!beginMutation(job.id)) return;
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
        let originalInput;
        if (action === "use-original") {
          cutoutController.current = new AbortController();
          originalInput = { ...await prepareOriginalCutout(job.originalAssetUrl, { onProgress: setCutoutProgress, signal: cutoutController.current.signal }), confirmOriginal: true };
          cutoutController.current = null;
          setCutoutProgress("");
        }
        const updated = await api(`${API}/${job.id}/stages/${stage}/${action}`, { method: "POST", body: originalInput ? JSON.stringify(originalInput) : action === "regenerate" ? JSON.stringify({ prompt, ...(stage === "modeled" ? { modelReferenceId } : {}) }) : undefined });
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
    } catch (requestError) { if (requestError.name !== "AbortError") setError(requestError.message); }
    finally { cutoutController.current = null; setCutoutProgress(""); endMutation(); }
  };

  const uploadModeled = async (job, image) => {
    if (!beginMutation(job.id)) return;
    try {
      const updated = await api(`${API}/${job.id}/stages/modeled/upload`, { method: "POST", body: JSON.stringify(image) });
      setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      setSelectedReviewId(job.id);
    } catch (requestError) { setError(requestError.message); return false; }
    finally { endMutation(); }
  };

  const performCleanup = async (job, action, requestedTolerance) => {
    if (!beginMutation(job.id)) return;
    try {
      const tolerance = requestedTolerance ?? cleanupTolerances[job.id] ?? job.stages?.garment?.cleanupTolerance ?? 46;
      const updated = await api(`${API}/${job.id}/stages/garment/cleanup-${action}`, { method: "POST", body: JSON.stringify({ tolerance }) });
      setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      setCleanupTolerances((current) => ({ ...current, [job.id]: updated.stages?.garment?.cleanupTolerance ?? tolerance }));
      setSelectedReviewId(job.id);
    } catch (requestError) { setError(requestError.message); }
    finally { endMutation(); }
  };

  const deleteJob = async (job) => {
    if (!beginMutation(job.id)) return;
    try {
      await api(`${API}/${job.id}`, { method: "DELETE" });
      const remaining = jobs.filter((item) => item.id !== job.id);
      setJobs(remaining);
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
      if (selectedReviewId === job.id) setSelectedReviewId(null);
      if (!remaining.length && !uploads.length) setOpen(false);
    } catch (requestError) { setError(requestError.message); }
    finally { endMutation(); }
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
      <input ref={inputRef} type="file" accept={IMAGE_ACCEPT} aria-label="Choose wardrobe images" multiple hidden disabled={!setup?.ready || Boolean(busyId)} onChange={(event) => { submitFiles(event.target.files); event.target.value = ""; }} />
      <div className="import-drop-overlay" data-active={dragging && !setupRequired} aria-hidden={!dragging || setupRequired}><div className="import-drop-target is-over"><UploadSimple size={34} weight="light" /><h2>Drop clothing images</h2><p>A single garment or a photo of a full outfit works. Your wardrobe stays exactly where you left it.</p></div></div>
      <aside className={`import-tray${hasImportActivity ? " is-expanded" : ""}`} aria-label="Wardrobe imports">
        <button className="import-tray__button" type="button" onClick={() => setupRequired || hasImportActivity ? setOpen(true) : inputRef.current?.click()} aria-label={setupRequired ? "Open setup instructions" : hasImportActivity ? "Open import progress" : "Add clothes"}>{activeStatus?.tone === "processing" ? <SpinnerGap size={19} className="import-spinner" /> : activeStatus?.tone === "error" ? <WarningCircle size={19} /> : readyCount ? <span>{readyCount}</span> : notice ? <X size={18} /> : <Plus size={19} />}</button>
        <div className="import-tray__actions">{(uploads[0]?.previewUrl || (!uploads.length && active)) && <OptimizedImage className="import-tray__preview" sizes="80px" src={uploads[0]?.previewUrl || active?.stages?.garment?.assetUrl || active?.stages?.garment?.failedAssetUrl || active?.stages?.crop?.assetUrl || active?.originalAssetUrl} alt="" />}<span className="import-tray__label" role="status">{activeStatus?.text || "Add clothes"}</span>{!setupRequired && <button className="import-icon-button" type="button" disabled={Boolean(busyId)} onClick={() => inputRef.current?.click()} aria-label="Choose images"><UploadSimple size={17} /></button>}</div>
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
          {cutoutProgress && <div className="import-cutout-progress" role="status" aria-live="polite"><SpinnerGap size={18} className="import-spinner" /><span>{cutoutProgress}</span><button className="import-button" onClick={() => cutoutController.current?.abort()}>Cancel</button></div>}
          {openingModeled && <p className="import-card__detail" role="status"><SpinnerGap size={16} className="import-spinner" /> Opening modelled shot…</p>}
          {openingModeled ? null : !jobs.length ? uploads.length ? null : setupRequired ? <div className="import-drop-target import-setup-warning"><WarningCircle size={30} /><h2>Setup required</h2><p>Add your OpenAI API key to <code>.env</code> and a PNG reference photo of yourself at <code>{setup.modelReference || "data/model-reference.png"}</code>, then restart the app.</p></div> : <div className="import-drop-target"><UploadSimple size={28} /><h2>{notice || error ? "Try another image" : "Choose or paste an image"}</h2><p>{notice?.detail || "We’ll isolate each clothing item, suggest its details, and hold everything for your approval."}</p><button className="import-button import-button--primary" disabled={!setup?.ready || Boolean(busyId)} onClick={() => inputRef.current?.click()}>Choose images</button></div> : (
            <>
              <div className={`import-progress${jobStatus?.tone !== "processing" ? " is-reviewing" : progress < 100 ? " is-indeterminate" : ""}`}><div className="import-progress__meta"><span>{jobStatus?.text}</span><span>{jobs.length} {jobs.length === 1 ? "item" : "items"}</span></div>{jobStatus?.tone === "processing" && <div className="import-progress__track"><div className="import-progress__bar" style={{ "--import-progress": `${progress}%` }} /></div>}</div>
              {reviewJob && reviewStage ? <ReviewEditor job={reviewJob} stage={reviewStage} references={setup?.modelReferences || []} selectedReference={referenceChoices[reviewJob.id] || reviewJob.modelReferenceId || "default"} setSelectedReference={(id) => setReferenceChoices((current) => ({ ...current, [reviewJob.id]: id }))} refreshReferences={refreshReferences} imageChoice={imageChoices[reviewJob.id] || (reviewJob.canUseOriginal ? "original" : "extract")} setImageChoice={(choice) => setImageChoices((current) => ({ ...current, [reviewJob.id]: choice }))} draft={drafts[reviewJob.id] || defaultDraft(reviewJob)} setDraft={(draft) => setDrafts((current) => ({ ...current, [reviewJob.id]: draft }))} regenPrompt={regenerationPrompts[`${reviewJob.id}:${reviewStage}`] || ""} setRegenPrompt={(prompt) => setRegenerationPrompts((current) => ({ ...current, [`${reviewJob.id}:${reviewStage}`]: prompt }))} busy={Boolean(busyId) || uploads.length > 0} onAction={(action, prompt) => perform(reviewJob, reviewStage, action, prompt)} detectionBusy={detectionBusyId === reviewJob.id} onDetectionAction={(action, body) => performDetection(reviewJob, action, body)} onUpload={(image) => uploadModeled(reviewJob, image)} /> : reviewJob && hasCleanupFailure(reviewJob) ? <CleanupEditor job={reviewJob} tolerance={cleanupTolerances[reviewJob.id] ?? reviewJob.stages.garment.cleanupTolerance ?? 46} setTolerance={(tolerance) => setCleanupTolerances((current) => ({ ...current, [reviewJob.id]: tolerance }))} busy={Boolean(busyId) || uploads.length > 0} onPreview={(tolerance) => performCleanup(reviewJob, "preview", tolerance)} onAccept={() => performCleanup(reviewJob, "accept")} /> : null}
              <div className="import-card-list">{jobs.map((job) => { const status = deriveStatus(job); const itemName = drafts[job.id]?.name || job.metadata?.name || "New piece"; const failedStage = job.stages?.garment?.status === "failed" ? "garment" : job.stages?.modeled?.status === "failed" ? "modeled" : null; return <article className={`import-card is-${status.tone}${reviewJob?.id === job.id ? " is-selected" : ""}`} key={job.id}><OptimizedImage className="import-card__image" sizes="96px" src={job.stages?.garment?.assetUrl || job.stages?.garment?.failedAssetUrl || job.stages?.crop?.assetUrl || job.originalAssetUrl} alt="" /><div className="import-card__body"><h3 className="import-card__title">{itemName}</h3><p className="import-card__detail import-card__detail--status" data-tone={status.tone}>{status.tone === "error" ? status.detail : status.text}</p></div><div className="import-card__actions">{status.tone === "ready" && <button className="import-icon-button" onClick={() => { setSelectedReviewId(job.id); setOpen(true); }} aria-label={`Review ${itemName}`}><Check size={17} /></button>}{failedStage && <><button className="import-button import-card__retry" disabled={Boolean(busyId) || uploads.length > 0} onClick={() => perform(job, failedStage, "regenerate", "")}><ArrowCounterClockwise size={14} /> Retry</button><CopyPrompt prompt={job.stages[failedStage]?.generationPrompt} className="import-button" disabled={Boolean(busyId) || uploads.length > 0} />{(failedStage === "modeled" || hasCleanupFailure(job)) && <button className="import-button" onClick={() => setSelectedReviewId(job.id)}>Review</button>}</>}<button className="import-icon-button import-card__delete" disabled={Boolean(busyId) || uploads.length > 0} onClick={() => deleteJob(job)} aria-label={`Delete ${itemName} from import queue`}><Trash size={16} /></button></div></article>; })}</div>
              <div className="import-actions"><button className="import-button" disabled={Boolean(busyId)} onClick={() => inputRef.current?.click()}><Plus size={14} /> Add another</button></div>
            </>
          )}
          {notice?.imageDataUrl && <div className="import-detection-retry import-undetected-retry">
            {jobs.length > 0 && <p className="import-card__detail">{notice.detail}</p>}
            <button className="import-button" disabled={Boolean(busyId) || uploads.length > 0 || !setup?.ready} onClick={retryUndetected}>{detectionBusyId === "undetected" ? <SpinnerGap size={14} className="import-spinner" /> : <ArrowCounterClockwise size={14} />} {detectionBusyId === "undetected" ? "Checking with Terra…" : "Retry with Terra"}</button>
            <p className="import-card__detail" role={detectionBusyId === "undetected" ? "status" : undefined}>{detectionBusyId === "undetected" ? "Checking the same uploaded image. Results will be ready for review." : "Check the same image with Terra. Uses paid API credits; any detected items come back for your review."}</p>
          </div>}
          {error && <p className="import-status is-error" role="alert">{error}</p>}
        </section>
      </div>
    </>
  );
}
