import { CopyPrompt, ModeledPhotoUpload } from "./modeled-photo-controls.jsx";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, ArrowRight, Check, Plus, X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { createViewResource } from "./view-resource.mjs";
import { OutfitFinder, OwnedItemSwaps } from "./outfit-discovery.jsx";
import { discoveryFingerprint, orderDiscovery } from "../shared/outfit-discovery.mjs";
import { uiErrorMessage } from "./ui-error.mjs";
import { ImageCheck } from "./image-check.jsx";
import { FavouriteButton, OutfitActivity, WearSummary } from "./outfit-activity.jsx";
import { inLaundry } from "../shared/garment-availability.mjs";
import { formatWearDate } from "../shared/outfit-activity.mjs";
import { OutfitPlans, PlanChooser, usePlanningDays } from "./outfit-plans.jsx";
import { OutfitShortlist } from "./outfit-shortlist.jsx";
import { OutfitVariation } from "./outfit-variation.jsx";
import "./outfit-view.css";

const API = "/api/outfits";
const EMPTY_ITEMS = [];
const running = (job) => ["planning", "generating"].includes(job.status) || job.outfits?.some((outfit) => ["planned", "generating"].includes(outfit.status));
const needsAttention = (job) => running(job) || job.status === "failed" || job.outfits?.some((outfit) => ["review", "failed"].includes(outfit.status));
const occasionText = (outfit) => (outfit.occasion || []).map((value) => value.replaceAll("-", " ")).join(" · ");

async function request(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(uiErrorMessage(result.error, "The request could not be completed. Please try again.")), { status: response.status });
  return result;
}

function mergeJobs(current, incoming) {
  const byId = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) {
    const previous = byId.get(job.id);
    if (!previous || !previous.updatedAt || !job.updatedAt || Date.parse(job.updatedAt) >= Date.parse(previous.updatedAt)) byId.set(job.id, job);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function jobSummary(job) {
  const outfits = job.outfits || [];
  const review = outfits.filter((outfit) => outfit.status === "review").length;
  const accepted = outfits.filter((outfit) => outfit.status === "accepted").length;
  const finished = outfits.filter((outfit) => ["review", "accepted", "rejected"].includes(outfit.status)).length;
  const failed = outfits.filter((outfit) => outfit.status === "failed").length;
  if (job.targetOutfitId && !running(job) && !review && !failed) return accepted ? "Photo added to your variation" : "Photo rejected · your cutout look is saved";
  if (job.status === "planning") return "Choosing combinations from your wardrobe…";
  if (running(job)) return `Creating photos · ${finished} of ${job.count} ready${review ? ` · ${review} to review` : ""}`;
  if (review) return `${review} ${review === 1 ? "outfit" : "outfits"} ready to review${failed ? ` · ${failed} need a retry` : ""}`;
  if (job.status === "failed" || failed) return failed ? `${failed} ${failed === 1 ? "photo needs" : "photos need"} a retry` : "Couldn't create these outfits";
  return `${accepted} ${accepted === 1 ? "outfit" : "outfits"} added to your collection`;
}

// Sizes follow the card, modal and reference layouts in outfit-view.css.
const CARD_PHOTO_SIZES = "(max-width: 580px) calc(100vw - 36px), (max-width: 860px) calc((100vw - 66px) / 2), (max-width: 960px) calc((100vw - 86px) / 2), (max-width: 1180px) calc((100vw - 104px) / 3), (max-width: 1800px) calc((100vw - 160px) / 3), 547px";
const DETAIL_PHOTO_SIZES = "(max-width: 580px) calc(100vw - 22px), (max-width: 734px) calc(100vw - 66px), (max-width: 960px) 670px, (max-width: 1304px) calc(60vw - 39.6px), 743px";
const GARMENT_PHOTO_SIZES = "(max-width: 580px) calc((100vw - 86px) / 3), (max-width: 960px) calc((100vw - 162px) / 4), 140px";

function Photo({ src, alt, className = "", priority = false, sizes = CARD_PHOTO_SIZES }) {
  const [failedSource, setFailedSource] = useState(null);
  if (!src || failedSource === src) return <div className={`outfit-photo-fallback ${className}`} role="img" aria-label={alt}>Photo unavailable</div>;
  return <OptimizedImage src={src} alt={alt} className={className} priority={priority} onError={() => setFailedSource(src)} sizes={sizes} />;
}

function OutfitModal({ title, className = "", onClose, children }) {
  const dialog = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    const node = dialog.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node.showModal();
    return () => {
      node.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return <dialog
    ref={dialog}
    className={`outfit-modal ${className}`}
    aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); closeRef.current(); }}
    onClick={(event) => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeRef.current(); } }}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const focusable = [...event.currentTarget.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((element) => element.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
  >
    <header className="outfit-modal-heading">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="outfit-close" onClick={onClose} aria-label="Close" autoFocus><X size={22} aria-hidden="true" /></button>
    </header>
    {children}
  </dialog>;
}

function GarmentReferences({ outfit, itemsById }) {
  return <section className="outfit-pieces" aria-label="Pieces in this outfit">
    <h3>From your wardrobe</h3>
    <div className="outfit-pieces-grid">
      {(outfit.garmentIds || []).map((id) => {
        const item = itemsById.get(id);
        return <div className="outfit-piece" key={id}>
          {item ? <Photo src={item.thumbnail || item.image} alt={item.name || "Wardrobe piece"} sizes={GARMENT_PHOTO_SIZES} /> : <div className="outfit-piece-missing" aria-hidden="true">—</div>}
          <p>{item?.name || "Piece no longer in your wardrobe"}{inLaundry(item) ? <span className="outfit-laundry-label">In laundry</span> : null}</p>
        </div>;
      })}
    </div>
  </section>;
}

function AccessorySuggestions({ outfit, visible = true }) {
  const [state, setState] = useState({ suggestions: null, loading: true, generating: false, error: "", hasApiKey: true });
  const active = useRef(null);
  const submitting = useRef(false);
  const endpoint = `${API}/${encodeURIComponent(outfit.id)}/accessories`;
  useEffect(() => {
    if (!visible) return undefined;
    const controller = new AbortController();
    active.current = controller;
    let timer;
    const load = async () => {
      try {
        const value = await request(endpoint, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setState({ ...value, loading: false, error: "" });
        if (value.generating) timer = window.setTimeout(load, 1500);
      } catch (error) { if (!controller.signal.aborted) setState((current) => ({ ...current, loading: false, generating: false, error: uiErrorMessage(error) })); }
    };
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [endpoint, visible]);
  const generate = async () => {
    if (submitting.current) return;
    submitting.current = true;
    const signal = active.current.signal;
    setState((current) => ({ ...current, generating: true, error: "" }));
    try {
      const value = await request(endpoint, { method: "POST", body: "{}", signal });
      if (!signal.aborted) setState({ ...value, loading: false, error: "" });
    } catch (error) { if (!signal.aborted) setState((current) => ({ ...current, generating: false, error: uiErrorMessage(error) })); }
    finally { submitting.current = false; }
  };
  return <section className="outfit-accessories" aria-label="Suggested accessories">
    <h3>Suggested accessories</h3>
    {state.suggestions ? <ul>{state.suggestions.map((suggestion) => <li key={suggestion}>{suggestion.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "")}</li>)}</ul> : <>
      <p className="outfit-small" role="status">{state.loading ? "Loading suggestions…" : state.generating ? "Choosing accessories for this look…" : !state.hasApiKey ? "Accessory suggestions are unavailable until the generation service is connected." : "A few optional finishing touches for this look."}</p>
      {state.error ? <p className="outfit-error" role="alert">{state.error}</p> : null}
      <button type="button" className="outfit-text-button" onClick={generate} disabled={state.loading || state.generating || !state.hasApiKey}>{state.generating ? "Suggesting…" : state.error ? "Try again" : "Suggest accessories"}</button>
    </>}
  </section>;
}

function OutfitDetails({ outfit, itemsById, visible = true, activity, children, showAccessories = true }) {
  return <div className="outfit-detail-layout">
    <div className="outfit-detail-photo">{!outfit.image && ["planned", "generating"].includes(outfit.status) ? <div className="outfit-photo-fallback" role="status">{outfit.status === "generating" ? "Creating this photo…" : "Waiting to create this photo…"}</div> : <Photo key={outfit.image || outfit.id} src={outfit.image} alt={`${outfit.name}, ${outfit.imageKind === "cutouts" ? "cutout preview" : "modelled head to toe"}`} sizes={DETAIL_PHOTO_SIZES} priority />}</div>
    <div className="outfit-detail-copy">
      {outfit.imageKind === "cutouts" ? <p className="outfit-occasion">Cutout preview</p> : null}
      {activity}
      <p className="outfit-occasion">{occasionText(outfit)}</p>
      <p className="outfit-reason">{outfit.reason}</p>
      <GarmentReferences outfit={outfit} itemsById={itemsById} />
      {outfit.status === "accepted" && outfit.imageKind !== "cutouts" && showAccessories ? <AccessorySuggestions key={`${outfit.id}:${outfit.image}`} outfit={outfit} visible={visible} /> : null}
      {children}
    </div>
  </div>;
}

function setupMessage(config) {
  if (!config) return "Generation settings couldn't be loaded. Refresh to try again.";
  if (!config.hasApiKey) return "Outfit generation is unavailable until the generation service is connected. Refresh after setup is complete.";
  if (!config.hasModelReference || !config.modelReferences?.length) return "A reference photo of you is needed to create outfits. Add one to your wardrobe setup, then refresh.";
  if (!config.counts?.upperbody || !config.counts?.lowerbody) return "Import at least one top and one bottom before creating outfits.";
  if (!config.availableCombinations) return "There are no new top-and-bottom combinations available. Add more pieces to create new looks.";
  if (!config.ready) return "Outfit generation is temporarily unavailable. Refresh to check again.";
  return "";
}

function GenerateForm({ config, configError, refreshing, onRefresh, busy, error, onSubmit, requiredGarmentId, itemsById, onRemoveGarment, photoOutfit }) {
  const [requestId] = useState(() => crypto.randomUUID());
  const garment = itemsById.get(requiredGarmentId);
  const available = requiredGarmentId ? config?.garmentCombinations?.[requiredGarmentId] : config?.availableCombinations;
  const maxCount = Math.max(1, Math.min(12, config?.maxCount || 12, available ?? 12));
  const [count, setCount] = useState(Math.min(6, maxCount));
  const [direction, setDirection] = useState("");
  const [modelReferenceId, setModelReferenceId] = useState(config?.modelReferences?.[0]?.id || "");
  const references = config?.modelReferences || [];
  const chosenReference = references.find((reference) => reference.id === modelReferenceId);
  const effectiveReference = chosenReference?.id || "";
  const problem = configError || (photoOutfit ? !config?.hasApiKey ? "Photo generation is unavailable until the generation service is connected." : !config.hasModelReference || !config.modelReferences?.length ? "Add a reference photo in wardrobe setup to create a modelled photo." : "" : setupMessage(config)) || (requiredGarmentId && (!garment || available === undefined) ? "This piece is no longer available for outfits. Remove it or refresh your wardrobe." : requiredGarmentId && !available ? "There are no new top-and-bottom combinations with this piece. Add more pieces or remove it to try other looks." : "");
  const validCount = Number.isInteger(Number(count)) && Number(count) >= 1 && Number(count) <= maxCount;
  useEffect(() => { setCount((current) => Math.min(Number(current) || 1, maxCount)); }, [maxCount]);

  return <form className="outfit-generate-form" onSubmit={(event) => { event.preventDefault(); if (!busy && !refreshing && !problem && validCount && effectiveReference) onSubmit({ ...(photoOutfit ? { requestId } : {}), count: photoOutfit ? 1 : Number(count), direction: direction.trim(), modelReferenceId: effectiveReference, ...(requiredGarmentId ? { requiredGarmentId } : {}) }); }}>
    <div className="outfit-form-content">
    <p className="outfit-form-intro">{photoOutfit ? "Create a photo of this exact combination using your reference. Review it before adding it to your saved variation." : "Your own pieces, modelled using your reference photo. Review each look before adding it to your collection."}</p>
    {photoOutfit ? <GarmentReferences outfit={photoOutfit} itemsById={itemsById} /> : null}
    {requiredGarmentId ? <section className="outfit-required-piece" aria-label="Piece included in every outfit">
      {garment ? <Photo src={garment.thumbnail || garment.image} alt="" sizes="64px" /> : null}
      <div><strong>{garment?.name || "Unavailable piece"}</strong><p>Included in every outfit</p></div>
      <button type="button" className="outfit-text-button" disabled={busy} onClick={onRemoveGarment} aria-label="Remove required piece">Remove</button>
    </section> : null}
    {problem ? <div className="outfit-notice" role="status"><p>{problem}</p><button type="button" className="outfit-text-button" onClick={onRefresh} disabled={refreshing || busy}>{refreshing ? "Refreshing…" : "Refresh settings"}</button></div> : null}
    <div className="outfit-form-row">
      {!photoOutfit ? <label className="outfit-field" htmlFor="outfit-count"><span>Number of outfits</span><input id="outfit-count" name="count" type="number" min="1" max={maxCount} step="1" value={count} onChange={(event) => setCount(event.target.value)} disabled={busy} required aria-describedby="outfit-count-hint" /><small id="outfit-count-hint">Choose 1–{maxCount} outfits.</small></label> : null}
      <label className="outfit-field" htmlFor="outfit-direction"><span>Styling direction <em>optional</em></span><textarea id="outfit-direction" name="direction" rows="2" maxLength={1000} value={direction} onChange={(event) => setDirection(event.target.value)} disabled={busy} placeholder="Relaxed dinners and warm-weather weekends" /><small>Leave blank for an everyday mix.</small></label>
    </div>
    {references.length ? <fieldset className="outfit-reference-picker" disabled={busy}>
      <legend>Your reference photo</legend>
      <div className="outfit-reference-options">{references.map((reference) => <label key={reference.id} className={effectiveReference === reference.id ? "selected" : ""}>
        <Photo src={reference.imageUrl} alt="" sizes="116px" />
        <span><input type="radio" name="outfit-model-reference" aria-label={reference.label} value={reference.id} checked={effectiveReference === reference.id} onChange={() => setModelReferenceId(reference.id)} />{reference.label}</span>
      </label>)}</div>
      <button type="button" className="outfit-text-button" onClick={onRefresh} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh photos"}</button>
    </fieldset> : null}
    {!chosenReference && modelReferenceId ? <p className="outfit-error" role="status">Your selected photo is unavailable. Choose another reference photo.</p> : !chosenReference && references.length ? <p className="outfit-small">Choose a reference photo of you.</p> : null}
    </div>
    <div className="outfit-form-actions">
      <p className="outfit-form-note">Generation may incur charges. You can close this window while your outfits are being created.</p>
      {error ? <p className="outfit-error" role="alert">{error}</p> : null}
      <button className="outfit-primary" type="submit" disabled={busy || refreshing || !!problem || !validCount || !effectiveReference}><Plus size={17} aria-hidden="true" />{busy ? "Starting…" : photoOutfit ? "Generate modelled photo" : `Generate ${validCount ? count : ""} ${Number(count) === 1 ? "outfit" : "outfits"}`}</button>
    </div>
  </form>;
}

function ReviewJob({ job, itemsById, busy, error, onAction, onRetryJob, visible = true, imageChecksReady = false }) {
  const [cropping, setCropping] = useState(false);
  const outfits = job.outfits || [];
  const [selectedId, setSelectedId] = useState(() => outfits.find((outfit) => ["review", "failed"].includes(outfit.status))?.id || outfits[0]?.id || null);
  const [correction, setCorrection] = useState("");
  const selected = outfits.find((outfit) => outfit.id === selectedId) || outfits.find((outfit) => ["review", "failed"].includes(outfit.status)) || outfits[0];
  const nextReview = outfits.find((outfit) => outfit.status === "review" && outfit.id !== selected?.id);
  const canReview = selected?.status === "review";
  const canRetry = selected && ["review", "failed", "rejected"].includes(selected.status);
  const select = (id) => { setSelectedId(id); setCorrection(""); };

  useEffect(() => {
    if (!selectedId && outfits.length) setSelectedId(outfits[0].id);
  }, [selectedId, outfits]);

  return <div className="outfit-review">
    <div className="outfit-job-intro">
      <p role="status" aria-live="polite">{jobSummary(job)}</p>
      {running(job) ? <p className="outfit-small">You can close this window and come back. Your progress is saved.</p> : null}
      {job.error ? <p className="outfit-error">{uiErrorMessage(job.error)}</p> : null}
      {job.status === "failed" || outfits.some((outfit) => outfit.status === "failed") ? <button className="outfit-secondary" type="button" onClick={() => onRetryJob(job.id)} disabled={busy || cropping || running(job)}><ArrowCounterClockwise size={16} aria-hidden="true" />Retry unfinished outfits</button> : null}
      {error ? <p className="outfit-error" role="alert">{error}</p> : null}
    </div>
    {outfits.length ? <>
      <nav className="outfit-review-strip" aria-label="Choose an outfit to review">{outfits.map((outfit, index) => <button type="button" key={outfit.id} className={outfit.id === selected?.id ? "selected" : ""} onClick={() => select(outfit.id)} aria-pressed={outfit.id === selected?.id} aria-label={`${index + 1}. ${outfit.name}: ${outfit.status === "review" ? "ready to review" : outfit.status === "accepted" ? "added to collection" : outfit.status === "failed" ? "needs a retry" : outfit.status === "rejected" ? "rejected" : "creating photo"}`}>
        {outfit.image ? <Photo src={outfit.image} alt="" sizes="40px" /> : <span className="outfit-review-number">{String(index + 1).padStart(2, "0")}</span>}
        <span>{outfit.name}</span>{outfit.status === "accepted" ? <Check size={14} aria-hidden="true" /> : null}
      </button>)}</nav>
      <h3 className="outfit-review-title">{selected.name}</h3>
      <OutfitDetails outfit={selected} itemsById={itemsById} visible={visible} showAccessories={!job.targetOutfitId}>
        <div className="outfit-review-actions">
          {selected.status === "failed" ? <p className="outfit-error">{uiErrorMessage(selected.error, "This image couldn't be created. Retry to generate it again.")}</p> : null}
          {["planned", "generating"].includes(selected.status) ? <p className="outfit-small" role="status">{selected.status === "generating" ? "Creating this photo…" : "This photo is next in line."}</p> : null}
          {canReview ? <><p className="outfit-small">Check your likeness, every piece, and the fit against the references.</p><ImageCheck endpoint={`${API}/jobs/${job.id}/outfits/${selected.id}/check`} fingerprint={JSON.stringify([job.updatedAt, selected.image, selected.status, [...itemsById.values()].map(item => [item.id, item.revision, item.image])])} enabled={imageChecksReady} active={visible} disabled={busy || cropping || running(job)} /><div className="outfit-action-row"><button className="outfit-primary" type="button" disabled={busy || cropping} onClick={() => onAction(job.id, selected.id, "approve")}><Check size={17} aria-hidden="true" />{job.targetOutfitId ? "Use this photo" : "Accept into collection"}</button><button className="outfit-secondary" type="button" disabled={busy || cropping} onClick={() => onAction(job.id, selected.id, "reject")}>Reject</button></div></> : null}
          {selected.status === "accepted" ? <p className="outfit-added"><Check size={17} aria-hidden="true" />{job.targetOutfitId ? "Photo added to your variation." : "Added to your collection."}</p> : null}
          {selected.status === "rejected" ? <p className="outfit-small">{job.targetOutfitId ? "Photo rejected. Your cutout variation is still saved." : "Rejected. This look is not in your collection."}</p> : null}
          {nextReview && ["accepted", "rejected"].includes(selected.status) ? <button className="outfit-secondary" type="button" onClick={() => select(nextReview.id)}>Next to review <ArrowRight size={16} aria-hidden="true" /></button> : null}
          {canRetry ? <div className="outfit-correction"><label className="outfit-field" htmlFor={`correction-${selected.id}`}><span>{selected.status === "failed" ? "Retry notes" : "Adjust this photo"} <em>optional</em></span><textarea id={`correction-${selected.id}`} rows="2" maxLength={1500} value={correction} disabled={busy || cropping} onChange={(event) => setCorrection(event.target.value)} placeholder="For example, keep the coat open and show the full shoes" /></label><div className="outfit-action-row"><button className="outfit-secondary" type="button" disabled={busy || cropping || running(job)} onClick={() => onAction(job.id, selected.id, "retry", { prompt: correction.trim() })}><ArrowCounterClockwise size={16} aria-hidden="true" />{selected.status === "failed" ? "Retry photo" : "Regenerate photo"}</button>{selected.status === "failed" && <CopyPrompt prompt={selected.generationPrompt} className="outfit-secondary" disabled={busy || cropping} />}</div><ModeledPhotoUpload key={selected.id} kind="outfit" className="outfit-secondary" disabled={busy || running(job)} onEditingChange={setCropping} onUpload={(image) => onAction(job.id, selected.id, "upload", image)} />{running(job) ? <p className="outfit-small">You can retry this photo when the current generation finishes.</p> : null}</div> : null}
        </div>
      </OutfitDetails>
    </> : <div className="outfit-planning-state"><div className={running(job) ? "outfit-progress-line" : ""} aria-hidden="true" /><p>{job.status === "failed" ? "Your existing collection is safe. Retry when you're ready." : "Finding a balanced mix of colours, shapes, and pieces from your wardrobe."}</p></div>}
  </div>;
}

function JobRow({ job, onOpen }) {
  return <button className="outfit-job-row" type="button" onClick={() => onOpen(job.id)}>
    <span><strong>{job.targetOutfitId ? "Variation photo" : `${job.count} outfit ${job.count === 1 ? "idea" : "ideas"}`}</strong><span className="outfit-job-summary">{jobSummary(job)}</span>{job.direction ? <span className="outfit-job-direction">{job.direction}</span> : null}</span>
    <span className="outfit-job-link">{running(job) ? "View progress" : needsAttention(job) ? "Review outfits" : "View results"}<ArrowRight size={17} aria-hidden="true" /></span>
  </button>;
}

export function OutfitView({ collection, items = EMPTY_ITEMS, wardrobeLoading = false, wardrobeError = "", onRefreshWardrobe, onAvailabilityChange, availabilityBusy = false, active = true, generationRequest, onGenerationHandled }) {
  const filterId = useId();
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [garmentFilter, setGarmentFilter] = useState("");
  const [occasionFilter, setOccasionFilter] = useState("");
  const [activityNotice, setActivityNotice] = useState(null);
  const [discoveryConfig, setDiscoveryConfig] = useState(null);
  const [discoveryResult, setDiscoveryResult] = useState(null);
  const { outfits, setOutfits, plans, setPlans, plansRevision, setPlansRevision, loading, loadError, setLoadError, refresh: refreshCollection } = collection;
  const planningDays = usePlanningDays();
  const [jobs, setJobs] = useState([]);
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [jobsError, setJobsError] = useState("");
  const [jobWarnings, setJobWarnings] = useState([]);
  const [actionError, setActionError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [refreshingConfig, setRefreshingConfig] = useState(true);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [modal, setModal] = useState(null);
  useEffect(() => {
    if (active && generationRequest) {
      setActionError("");
      if (["plan", "open"].includes(generationRequest.type)) {
        if (loading || loadError) return;
        const outfit = outfits.find(item => item.id === generationRequest.outfitId);
        if (!outfit) setActionError("That saved look is no longer available. Choose another look.");
        else setModal(generationRequest.type === "plan" ? { type: "plan", id: outfit.id, date: generationRequest.date, revision: generationRequest.revision } : { type: "outfit", id: outfit.id });
      } else if (generationRequest.type === "filter") {
        setGarmentFilter(generationRequest.garmentId);
        setOccasionFilter(""); setFavouritesOnly(false); setDiscoveryResult(null); setModal(null);
      } else setModal({ type: "generate", requiredGarmentId: generationRequest.garmentId });
      onGenerationHandled();
    }
  }, [active, generationRequest, onGenerationHandled, loading, loadError, outfits]);
  const mounted = useRef(false);
  const isActive = useRef(active);
  isActive.current = active;
  const busy = useRef(false);
  const mutationVersion = useRef(0);
  const resources = useRef(null);
  const wardrobeFingerprint = useMemo(() => JSON.stringify(items.map(({ id, part, image, revision }) => [id, part, image, revision])), [items]);
  const previousWardrobe = useRef(wardrobeFingerprint);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const fingerprint = useMemo(() => discoveryFingerprint(outfits, items), [outfits, items]);
  const currentDiscovery = discoveryConfig?.ready && discoveryResult?.fingerprint === fingerprint ? discoveryResult : null;
  const occasions = [...new Set(outfits.flatMap((outfit) => outfit.occasion || []))].sort((a, b) => a.localeCompare(b));
  const garmentIds = new Set(outfits.flatMap((outfit) => outfit.garmentIds));
  if (garmentFilter) garmentIds.add(garmentFilter);
  const filterGarments = [...garmentIds].map((id) => ({ id, name: itemsById.get(id)?.name || "Piece no longer in your wardrobe" })).sort((a, b) => a.name.localeCompare(b.name));
  const hasFilters = favouritesOnly || garmentFilter || occasionFilter;
  const clearFilters = () => { setFavouritesOnly(false); setGarmentFilter(""); setOccasionFilter(""); };
  const displayedOutfits = useMemo(() => {
    const outfitsById = new Map(outfits.map((outfit) => [outfit.id, outfit]));
    const ranked = currentDiscovery ? orderDiscovery(currentDiscovery.rankings, currentDiscovery).map(({ id }) => outfitsById.get(id)).filter(Boolean) : outfits;
    return ranked.filter((outfit) => (!favouritesOnly || outfit.favourite) && (!garmentFilter || outfit.garmentIds.includes(garmentFilter)) && (!occasionFilter || outfit.occasion.includes(occasionFilter)));
  }, [currentDiscovery, outfits, favouritesOnly, garmentFilter, occasionFilter]);

  if (!resources.current) resources.current = {
    discovery: createViewResource({
      load: (signal) => request(`${API}/discovery/config`, { signal }),
      onValue: setDiscoveryConfig,
      onError: () => setDiscoveryConfig(null),
    }),
    config: createViewResource({
      load: (signal) => request(`${API}/config`, { signal }),
      onValue: (value) => { setConfig(value); setConfigError(""); },
      onError: (error) => setConfigError(uiErrorMessage(error)),
      onLoading: (value) => { if (mounted.current) setRefreshingConfig(value); },
    }),
    jobs: createViewResource({
      load: (signal) => request(`${API}/jobs`, { signal }),
      onValue: (value) => {
        const incoming = value.jobs || [];
        const incomingIds = new Set(incoming.map((job) => job.id));
        setJobs((current) => mergeJobs(current.filter((job) => incomingIds.has(job.id)), incoming));
        setJobWarnings(value.warnings || []); setJobsError("");
      },
      onError: (error) => setJobsError(uiErrorMessage(error)),
    }),
  };

  const refreshConfig = useCallback(() => { void resources.current.config.refresh({ force: true }).catch(() => {}); }, []);
  const refreshView = useCallback((force = false) => {
    for (const resource of Object.values(resources.current)) void resource.refresh({ force }).catch(() => {});
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const resource of Object.values(resources.current)) resource.cancel(); };
  }, []);

  useEffect(() => {
    if (active && visible) refreshView();
    else for (const resource of Object.values(resources.current)) resource.cancel();
    if (!active) { setModal(null); setActionError(""); }
  }, [active, visible, refreshView]);

  useEffect(() => {
    const refreshVisible = () => {
      const nextVisible = document.visibilityState !== "hidden";
      setVisible(nextVisible);
      if (isActive.current && nextVisible) refreshView(true);
    };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { window.removeEventListener("focus", refreshVisible); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [refreshView]);

  useEffect(() => {
    if (previousWardrobe.current === wardrobeFingerprint) return;
    previousWardrobe.current = wardrobeFingerprint;
    resources.current.config.invalidate();
    if (active && visible) refreshConfig();
  }, [wardrobeFingerprint, active, visible, refreshConfig]);

  const activeJobIds = jobs.filter(running).map((job) => job.id).sort().join(",");
  useEffect(() => {
    if (!active || !visible || !activeJobIds) return undefined;
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      const version = mutationVersion.current;
      const results = await Promise.allSettled(activeJobIds.split(",").map((id) => request(`${API}/jobs/${encodeURIComponent(id)}`, { signal: controller.signal })));
      if (controller.signal.aborted) return;
      if (version === mutationVersion.current) {
        const updates = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
        if (updates.length) setJobs((current) => mergeJobs(current, updates));
        setJobsError(results.some((result) => result.status === "rejected") ? "Progress couldn't be refreshed. Reconnecting automatically…" : "");
      }
      timer = window.setTimeout(poll, 2500);
    };
    timer = window.setTimeout(poll, 1500);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [activeJobIds, active, visible]);

  const mutate = async (key, path, body, after) => {
    if (busy.current) return false;
    busy.current = true;
    ++mutationVersion.current;
    resources.current.jobs.invalidate();
    setBusyKey(key);
    setActionError("");
    try {
      const job = await request(path, { method: "POST", body: JSON.stringify(body || {}) });
      if (mounted.current) {
        // A focus refresh may have started while the mutation was in flight.
        resources.current.jobs.invalidate();
        resources.current.config.invalidate();
        setJobs((current) => mergeJobs(current, [job]));
        if (isActive.current && document.visibilityState !== "hidden") refreshConfig();
        await after?.(job);
      }
    } catch (error) { if (mounted.current) setActionError(uiErrorMessage(error)); return false; }
    finally { busy.current = false; ++mutationVersion.current; if (mounted.current) setBusyKey(""); }
  };
  const closeModal = () => { setModal(null); setActionError(""); };
  const changeActivity = async (outfit, action, body) => {
    if (busy.current) return;
    busy.current = true;
    setBusyKey(`activity-${outfit.id}`); setActionError(""); setActivityNotice(null);
    collection.resource.invalidate();
    try {
      const saved = await request(`${API}/${encodeURIComponent(outfit.id)}/${action}`, { method: "POST", body: JSON.stringify(body) });
      if (!mounted.current) return;
      collection.resource.invalidate();
      setOutfits((current) => current.map((item) => item.id === saved.id ? saved : item));
      if (action === "wears") {
        setActivityNotice({ outfitId: outfit.id, text: `Wear logged for ${formatWearDate(body.date)}.`, eventId: saved.wearHistory.find((event) => event.date === body.date)?.id });
        if (body.planDate && isActive.current) setModal({ type: "outfit", id: saved.id });
      }
      else setActivityNotice({ outfitId: outfit.id, text: action === "favourite" ? saved.favourite ? "Added to favourites." : "Removed from favourites." : "Wear removed." });
    } catch (error) {
      if (mounted.current) {
        setActionError(uiErrorMessage(error));
        collection.resource.invalidate();
        // Recover uncertain writes; the server also deduplicates outfit/date logs.
        await refreshCollection().catch(() => {});
      }
    } finally { busy.current = false; if (mounted.current) setBusyKey(""); }
  };
  const openJob = (id) => { setActionError(""); setModal({ type: "job", id }); };
  const startGeneration = (body) => mutate("create", `${API}/jobs`, body, (job) => { if (isActive.current) setModal({ type: "job", id: job.id }); });
  const retryJob = (id) => mutate(`retry-${id}`, `${API}/jobs/${encodeURIComponent(id)}/retry`);
  const outfitAction = (jobId, outfitId, action, body) => mutate(`${action}-${outfitId}`, `${API}/jobs/${encodeURIComponent(jobId)}/outfits/${encodeURIComponent(outfitId)}/${action}`, body, action === "approve" ? async () => {
    collection.resource.invalidate();
    if (!isActive.current || document.visibilityState === "hidden") return;
    try { await refreshCollection(); } catch { if (mounted.current) setLoadError("The outfit was saved, but the collection couldn't be refreshed. Reload the collection to see it."); }
  } : undefined);
  const openVariation = (outfit, initialSwap, planDate) => { setActionError(""); setModal({ type: "variation", source: structuredClone(outfit), initialSwap, planDate, planRevision: plansRevision }); };
  const saveVariation = async (source, body) => {
    if (busy.current) return;
    busy.current = true; setBusyKey("variation"); setActionError("");
    collection.resource.invalidate();
    try {
      const saved = await request(`${API}/${encodeURIComponent(source.id)}/variations`, { method: "POST", body: JSON.stringify(body) });
      if (!mounted.current) return;
      collection.resource.invalidate(); resources.current.config.invalidate();
      setOutfits(current => [...current.filter(item => item.id !== saved.id), saved]);
      clearFilters(); setDiscoveryResult(null); refreshConfig();
      if (isActive.current) setModal(modal?.planDate ? { type: "plan", date: modal.planDate, id: saved.id, revision: modal.planRevision } : { type: "outfit", id: saved.id });
    } catch (error) {
      if (mounted.current) { setActionError(uiErrorMessage(error)); await refreshCollection().catch(() => {}); }
    } finally { busy.current = false; if (mounted.current) setBusyKey(""); }
  };
  const openPlan = (date, id, fromDate) => { setActionError(""); setModal({ type: "plan", date, id, fromDate, revision: plansRevision }); };
  const savePlan = async (body) => {
    if (busy.current || loading || loadError || wardrobeLoading || wardrobeError) return;
    busy.current = true; setBusyKey("plan"); setActionError("");
    collection.resource.invalidate();
    try {
      const saved = await request(`${API}/plans`, { method: "POST", body: JSON.stringify({ ...body, revision: modal?.type === "plan" ? modal.revision ?? plansRevision : plansRevision, timezoneOffset: new Date().getTimezoneOffset() }) });
      if (!mounted.current) return;
      collection.resource.invalidate();
      setPlans(saved.plans); setPlansRevision(saved.plansRevision);
      if (isActive.current) setModal(null);
    } catch (error) {
      if (mounted.current) {
        setActionError(uiErrorMessage(error));
        collection.resource.invalidate();
        await refreshCollection().catch(() => {});
        // A conflicted choice must be reopened against the refreshed plan.
        if (error.status === 409 && isActive.current) setModal(null);
      }
    } finally { busy.current = false; if (mounted.current) setBusyKey(""); }
  };
  const planUnavailable = loading ? "Refreshing your plans…" : loadError ? "Your collection could not be refreshed." : wardrobeLoading ? "Checking your wardrobe…" : wardrobeError ? "Your wardrobe could not be refreshed." : "";
  const refreshPlans = () => { void refreshCollection().catch(() => {}); void onRefreshWardrobe?.(); };
  const openPhoto = (outfit) => {
    const pending = jobs.find(job => job.targetOutfitId === outfit.id && needsAttention(job));
    setActionError(""); setModal(pending ? { type: "job", id: pending.id } : { type: "photo", id: outfit.id });
  };
  const photoOutfit = modal?.type === "photo" ? outfits.find(outfit => outfit.id === modal.id) : null;
  const currentJobs = jobs.filter(needsAttention);
  const previousJobs = jobs.filter((job) => !needsAttention(job));
  const selectedOutfit = modal?.type === "outfit" ? outfits.find((outfit) => outfit.id === modal.id) : null;
  const selectedJob = modal?.type === "job" ? jobs.find((job) => job.id === modal.id) : null;

  return <main className="outfit-page">
    <header className="outfit-page-heading">
      <div><p className="outfit-count">{loading ? "Your collection" : `${outfits.length} ${outfits.length === 1 ? "outfit" : "outfits"}`}</p><h1>Outfits</h1><p>New ways to wear the pieces you already own.</p></div>
      <button className="outfit-primary" type="button" onClick={() => { setActionError(""); setModal({ type: "generate" }); }} disabled={!config && refreshingConfig}><Plus size={18} aria-hidden="true" />Generate outfits</button>
    </header>
    {!loading || outfits.length || plans.length ? <OutfitPlans plans={plans} outfits={outfits} itemsById={itemsById} days={planningDays} busy={!!busyKey || availabilityBusy} unavailable={planUnavailable} onRefresh={refreshPlans} onChoose={openPlan} onClear={date => savePlan({ date, outfitId: null })} onOpen={id => { setActionError(""); setModal({ type: "outfit", id }); }} onVariation={(outfit, date) => openVariation(outfit, undefined, date)} onWear={(outfit, date) => changeActivity(outfit, "wears", { date, planDate: date, plansRevision })} /> : null}
    {outfits.length ? <OutfitShortlist garmentWears={collection.garmentWears} outfits={outfits} itemsById={itemsById} unavailable={wardrobeLoading ? "Loading your wardrobe…" : wardrobeError ? "Your wardrobe could not be refreshed. Refresh it before choosing a look." : loadError ? "The shortlist is unavailable until your collection can be refreshed." : ""} onRefresh={wardrobeError ? onRefreshWardrobe : undefined} onOpen={id => { setActionError(""); setModal({ type: "outfit", id }); }} /> : null}
    {outfits.length ? <h2 className="outfit-collection-heading">Browse your collection</h2> : null}
    {outfits.length || hasFilters ? <section className="outfit-filters" aria-label="Filter saved outfits">
      <div className="outfit-filter-fields">
        <button type="button" className="outfit-secondary" aria-pressed={favouritesOnly} onClick={() => setFavouritesOnly((value) => !value)}>Favourites</button>
        <label className="outfit-field" htmlFor={`${filterId}-occasion`}><span>Occasion</span><select id={`${filterId}-occasion`} value={occasionFilter} onChange={(event) => setOccasionFilter(event.target.value)}><option value="">All occasions</option>{occasions.map((occasion) => <option key={occasion} value={occasion}>{occasion.replaceAll("-", " ")}</option>)}</select></label>
        <label className="outfit-field" htmlFor={`${filterId}-garment`}><span>Garment</span><select id={`${filterId}-garment`} value={garmentFilter} onChange={(event) => setGarmentFilter(event.target.value)}><option value="">All pieces</option>{filterGarments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {hasFilters ? <button type="button" className="outfit-text-button" onClick={clearFilters}>Clear filters</button> : null}
      </div>
      <p className="outfit-small" role="status">{displayedOutfits.length} of {outfits.length} saved outfits{currentDiscovery ? " · Within your search results" : ""}</p>
    </section> : null}
    {outfits.length ? <OutfitFinder config={discoveryConfig} fingerprint={fingerprint} active={active && visible} result={currentDiscovery} onChange={setDiscoveryResult} /> : null}
    {jobsError ? <div className="outfit-page-notice" role="status"><p>{jobsError}</p><button className="outfit-text-button" type="button" onClick={() => { void resources.current.jobs.refresh({ force: true }).catch(() => {}); }}>Refresh</button></div> : null}
    {jobWarnings.length ? <div className="outfit-page-notice" role="alert"><p>Some saved generations need attention.</p><ul>{jobWarnings.map((warning) => <li key={warning}>{uiErrorMessage(warning)}</li>)}</ul></div> : null}
    {actionError && !modal ? <p className="outfit-page-notice outfit-error" role="alert">{actionError}</p> : null}
    {currentJobs.length ? <section className="outfit-jobs" aria-label="Outfits in progress">{currentJobs.map((job) => <JobRow key={job.id} job={job} onOpen={openJob} />)}</section> : null}
    {loadError ? <div className="outfit-page-notice" role="alert"><p>{loadError}</p><button className="outfit-text-button" type="button" onClick={() => { void refreshCollection().catch(() => {}); }}>Reload collection</button></div> : null}
    {loading && !outfits.length ? <p className="outfit-empty" role="status">Loading your outfits…</p> : null}
    {!loading && !loadError && !outfits.length ? <div className="outfit-empty"><h2>Your next look starts here.</h2><p>Generate a collection from your wardrobe, then keep the looks you love.</p></div> : null}
    {!loading && outfits.length > 0 && !displayedOutfits.length ? <div className="outfit-empty"><h2>No outfits match.</h2><p>{hasFilters ? "Try another occasion or piece, or clear your filters." : "Try another search or browse all saved outfits."}</p></div> : null}
    {displayedOutfits.length ? <section className="outfit-grid" aria-label={currentDiscovery ? "Matching saved outfits" : "Your outfit collection"}>{displayedOutfits.map((outfit, index) => <article className="outfit-card-entry" key={outfit.id}><button className="outfit-card" type="button" onClick={() => { setActionError(""); setModal({ type: "outfit", id: outfit.id }); }} aria-label={`View ${outfit.name}`}><div className="outfit-card-photo"><Photo src={outfit.image} alt={`${outfit.name}, ${outfit.imageKind === "cutouts" ? "cutout preview" : "modelled outfit"}`} priority={index < 3} /></div><div className="outfit-card-caption"><h2>{outfit.name}</h2><ArrowRight size={19} aria-hidden="true" /><p>{outfit.imageKind === "cutouts" ? "Cutout preview · " : ""}{occasionText(outfit)}</p><p><WearSummary outfit={outfit} /></p>{outfit.garmentIds.some(id => inLaundry(itemsById.get(id))) ? <p>Pieces in laundry</p> : null}</div></button><FavouriteButton outfit={outfit} busy={!!busyKey} onChange={changeActivity} compact /></article>)}</section> : null}
    {previousJobs.length ? <details className="outfit-history"><summary>Previous generations <span>({previousJobs.length})</span></summary>{previousJobs.map((job) => <JobRow key={job.id} job={job} onOpen={openJob} />)}</details> : null}
    {active && modal?.type === "generate" ? <OutfitModal title="Generate outfits" className="outfit-generate-modal" onClose={closeModal}>{!config && refreshingConfig ? <p className="outfit-form-intro" role="status">Loading generation settings…</p> : <GenerateForm config={config} configError={configError} refreshing={refreshingConfig} onRefresh={refreshConfig} busy={!!busyKey} error={actionError} onSubmit={startGeneration} requiredGarmentId={modal.requiredGarmentId} itemsById={itemsById} onRemoveGarment={() => setModal({ type: "generate" })} />}</OutfitModal> : null}
    {active && modal?.type === "plan" ? <OutfitModal className="outfit-plan-modal" title={modal.date === planningDays[0] ? "Plan for today" : "Plan for tomorrow"} onClose={closeModal}><PlanChooser key={`${modal.date}-${modal.id || ''}-${modal.fromDate || ''}`} date={modal.date} fromDate={modal.fromDate} initialId={modal.id} plans={plans} outfits={outfits} itemsById={itemsById} days={planningDays} busy={!!busyKey || availabilityBusy} unavailable={planUnavailable} error={actionError} onRefresh={refreshPlans} onSave={savePlan} /></OutfitModal> : null}
    {active && selectedOutfit ? <OutfitModal title={selectedOutfit.name} onClose={closeModal}><OutfitDetails outfit={selectedOutfit} itemsById={itemsById} visible={visible} activity={<><div className="outfit-variation-actions">{planningDays.map((date, index) => <button key={date} type="button" className="outfit-secondary" disabled={!!busyKey || availabilityBusy || !!planUnavailable} onClick={() => openPlan(date, selectedOutfit.id)}>Plan for {index ? "tomorrow" : "today"}</button>)}</div><div className="outfit-variation-actions"><button type="button" className="outfit-secondary" disabled={!!busyKey} onClick={() => openVariation(selectedOutfit)}>Change one piece</button>{selectedOutfit.imageKind === "cutouts" ? <button type="button" className="outfit-secondary" disabled={!!busyKey} onClick={() => openPhoto(selectedOutfit)}>{jobs.some(job => job.targetOutfitId === selectedOutfit.id && needsAttention(job)) ? "View photo progress" : "Create modelled photo"}</button> : null}</div><OutfitActivity key={selectedOutfit.id} outfit={selectedOutfit} itemsById={itemsById} busy={!!busyKey || availabilityBusy} error={actionError} notice={activityNotice} onChange={changeActivity} onAvailabilityChange={onAvailabilityChange} wardrobeError={wardrobeError} onRefreshWardrobe={onRefreshWardrobe} /></>}>{discoveryConfig?.ready && selectedOutfit.imageKind !== "cutouts" ? <OwnedItemSwaps key={selectedOutfit.id} outfit={selectedOutfit} itemsById={itemsById} fingerprint={fingerprint} active={visible} onSelect={swap => openVariation(selectedOutfit, swap)} /> : null}</OutfitDetails></OutfitModal> : null}
    {active && modal?.type === "variation" ? <OutfitModal title="Change one piece" onClose={closeModal}><OutfitVariation outfit={modal.source} itemsById={itemsById} initialSwap={modal.initialSwap} busy={!!busyKey} error={actionError} onSave={saveVariation} onCancel={() => { setActionError(""); setModal({ type: "outfit", id: modal.source.id }); }} /></OutfitModal> : null}
    {active && photoOutfit ? <OutfitModal title="Create modelled photo" className="outfit-generate-modal" onClose={closeModal}>{!config && refreshingConfig ? <p role="status">Loading generation settings…</p> : <GenerateForm key={photoOutfit.id} config={config} configError={configError} refreshing={refreshingConfig} onRefresh={refreshConfig} busy={!!busyKey} error={actionError} itemsById={itemsById} photoOutfit={photoOutfit} onSubmit={body => mutate("photo", `${API}/${encodeURIComponent(photoOutfit.id)}/photo`, body, job => { if (isActive.current) setModal({ type: "job", id: job.id }); })} />}</OutfitModal> : null}
    {active && selectedJob ? <OutfitModal title={selectedJob.targetOutfitId ? "Modelled photo" : `${selectedJob.count} outfit ${selectedJob.count === 1 ? "idea" : "ideas"}`} className="outfit-review-modal" onClose={closeModal}><ReviewJob key={selectedJob.id} job={selectedJob} itemsById={itemsById} busy={!!busyKey} error={actionError} onAction={outfitAction} onRetryJob={retryJob} visible={visible} imageChecksReady={config?.imageChecks?.ready} /></OutfitModal> : null}
  </main>;
}
