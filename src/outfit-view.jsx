import { CopyPrompt, ModeledPhotoUpload } from "./modeled-photo-controls.jsx";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, ArrowRight, Check, Plus, X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { createViewResource } from "./view-resource.mjs";
import { OutfitFinder, OwnedItemSwaps } from "./outfit-discovery.jsx";
import { discoveryFingerprint, orderDiscovery } from "../shared/outfit-discovery.mjs";
import { uiErrorMessage } from "./ui-error.mjs";
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
  if (!response.ok) throw new Error(uiErrorMessage(result.error, "The request could not be completed. Please try again."));
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
          <p>{item?.name || "Piece no longer in your wardrobe"}</p>
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

function OutfitDetails({ outfit, itemsById, visible = true, children }) {
  return <div className="outfit-detail-layout">
    <div className="outfit-detail-photo">{!outfit.image && ["planned", "generating"].includes(outfit.status) ? <div className="outfit-photo-fallback" role="status">{outfit.status === "generating" ? "Creating this photo…" : "Waiting to create this photo…"}</div> : <Photo key={outfit.image || outfit.id} src={outfit.image} alt={`${outfit.name}, modelled head to toe`} sizes={DETAIL_PHOTO_SIZES} priority />}</div>
    <div className="outfit-detail-copy">
      <p className="outfit-occasion">{occasionText(outfit)}</p>
      <p className="outfit-reason">{outfit.reason}</p>
      <GarmentReferences outfit={outfit} itemsById={itemsById} />
      {outfit.status === "accepted" ? <AccessorySuggestions key={`${outfit.id}:${outfit.image}`} outfit={outfit} visible={visible} /> : null}
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

function GenerateForm({ config, configError, refreshing, onRefresh, busy, error, onSubmit }) {
  const maxCount = Math.max(1, Math.min(12, config?.maxCount || 12, config?.availableCombinations ?? 12));
  const [count, setCount] = useState(Math.min(6, maxCount));
  const [direction, setDirection] = useState("");
  const [modelReferenceId, setModelReferenceId] = useState(config?.modelReferences?.[0]?.id || "");
  const references = config?.modelReferences || [];
  const chosenReference = references.find((reference) => reference.id === modelReferenceId);
  const effectiveReference = chosenReference?.id || "";
  const problem = configError || setupMessage(config);
  const validCount = Number.isInteger(Number(count)) && Number(count) >= 1 && Number(count) <= maxCount;

  return <form className="outfit-generate-form" onSubmit={(event) => { event.preventDefault(); if (!busy && !refreshing && !problem && validCount && effectiveReference) onSubmit({ count: Number(count), direction: direction.trim(), modelReferenceId: effectiveReference }); }}>
    <div className="outfit-form-content">
    <p className="outfit-form-intro">Your own pieces, modelled using your reference photo. Review each look before adding it to your collection.</p>
    {problem ? <div className="outfit-notice" role="status"><p>{problem}</p><button type="button" className="outfit-text-button" onClick={onRefresh} disabled={refreshing || busy}>{refreshing ? "Refreshing…" : "Refresh settings"}</button></div> : null}
    <div className="outfit-form-row">
      <label className="outfit-field" htmlFor="outfit-count"><span>Number of outfits</span><input id="outfit-count" name="count" type="number" min="1" max={maxCount} step="1" value={count} onChange={(event) => setCount(event.target.value)} disabled={busy} required aria-describedby="outfit-count-hint" /><small id="outfit-count-hint">Choose 1–{maxCount} outfits.</small></label>
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
      <button className="outfit-primary" type="submit" disabled={busy || refreshing || !!problem || !validCount || !effectiveReference}><Plus size={17} aria-hidden="true" />{busy ? "Starting…" : `Generate ${validCount ? count : ""} ${Number(count) === 1 ? "outfit" : "outfits"}`}</button>
    </div>
  </form>;
}

function ReviewJob({ job, itemsById, busy, error, onAction, onRetryJob, visible = true }) {
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
      <OutfitDetails outfit={selected} itemsById={itemsById} visible={visible}>
        <div className="outfit-review-actions">
          {selected.status === "failed" ? <p className="outfit-error">{uiErrorMessage(selected.error, "This image couldn't be created. Retry to generate it again.")}</p> : null}
          {["planned", "generating"].includes(selected.status) ? <p className="outfit-small" role="status">{selected.status === "generating" ? "Creating this photo…" : "This photo is next in line."}</p> : null}
          {canReview ? <><p className="outfit-small">Check your likeness, every piece, and the fit against the references.</p><div className="outfit-action-row"><button className="outfit-primary" type="button" disabled={busy || cropping} onClick={() => onAction(job.id, selected.id, "approve")}><Check size={17} aria-hidden="true" />Accept into collection</button><button className="outfit-secondary" type="button" disabled={busy || cropping} onClick={() => onAction(job.id, selected.id, "reject")}>Reject</button></div></> : null}
          {selected.status === "accepted" ? <p className="outfit-added"><Check size={17} aria-hidden="true" />Added to your collection.</p> : null}
          {selected.status === "rejected" ? <p className="outfit-small">Rejected. This look is not in your collection.</p> : null}
          {nextReview && ["accepted", "rejected"].includes(selected.status) ? <button className="outfit-secondary" type="button" onClick={() => select(nextReview.id)}>Next to review <ArrowRight size={16} aria-hidden="true" /></button> : null}
          {canRetry ? <div className="outfit-correction"><label className="outfit-field" htmlFor={`correction-${selected.id}`}><span>{selected.status === "failed" ? "Retry notes" : "Adjust this photo"} <em>optional</em></span><textarea id={`correction-${selected.id}`} rows="2" maxLength={1500} value={correction} disabled={busy || cropping} onChange={(event) => setCorrection(event.target.value)} placeholder="For example, keep the coat open and show the full shoes" /></label><div className="outfit-action-row"><button className="outfit-secondary" type="button" disabled={busy || cropping || running(job)} onClick={() => onAction(job.id, selected.id, "retry", { prompt: correction.trim() })}><ArrowCounterClockwise size={16} aria-hidden="true" />{selected.status === "failed" ? "Retry photo" : "Regenerate photo"}</button>{selected.status === "failed" && <CopyPrompt prompt={selected.generationPrompt} className="outfit-secondary" disabled={busy || cropping} />}</div><ModeledPhotoUpload key={selected.id} kind="outfit" className="outfit-secondary" disabled={busy || running(job)} onEditingChange={setCropping} onUpload={(image) => onAction(job.id, selected.id, "upload", image)} />{running(job) ? <p className="outfit-small">You can retry this photo when the current generation finishes.</p> : null}</div> : null}
        </div>
      </OutfitDetails>
    </> : <div className="outfit-planning-state"><div className={running(job) ? "outfit-progress-line" : ""} aria-hidden="true" /><p>{job.status === "failed" ? "Your existing collection is safe. Retry when you're ready." : "Finding a balanced mix of colours, shapes, and pieces from your wardrobe."}</p></div>}
  </div>;
}

function JobRow({ job, onOpen }) {
  return <button className="outfit-job-row" type="button" onClick={() => onOpen(job.id)}>
    <span><strong>{job.count} outfit {job.count === 1 ? "idea" : "ideas"}</strong><span className="outfit-job-summary">{jobSummary(job)}</span>{job.direction ? <span className="outfit-job-direction">{job.direction}</span> : null}</span>
    <span className="outfit-job-link">{running(job) ? "View progress" : needsAttention(job) ? "Review outfits" : "View results"}<ArrowRight size={17} aria-hidden="true" /></span>
  </button>;
}

export function OutfitView({ items = EMPTY_ITEMS, active = true }) {
  const [discoveryConfig, setDiscoveryConfig] = useState(null);
  const [discoveryResult, setDiscoveryResult] = useState(null);
  const [outfits, setOutfits] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [configError, setConfigError] = useState("");
  const [jobsError, setJobsError] = useState("");
  const [jobWarnings, setJobWarnings] = useState([]);
  const [actionError, setActionError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [refreshingConfig, setRefreshingConfig] = useState(true);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [modal, setModal] = useState(null);
  const mounted = useRef(false);
  const isActive = useRef(active);
  isActive.current = active;
  const busy = useRef(false);
  const mutationVersion = useRef(0);
  const resources = useRef(null);
  const wardrobeFingerprint = JSON.stringify(items.map(({ id, part, image, revision }) => [id, part, image, revision]));
  const previousWardrobe = useRef(wardrobeFingerprint);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const fingerprint = discoveryFingerprint(outfits, items);
  const currentDiscovery = discoveryConfig?.ready && discoveryResult?.fingerprint === fingerprint ? discoveryResult : null;
  const outfitsById = new Map(outfits.map((outfit) => [outfit.id, outfit]));
  const displayedOutfits = currentDiscovery ? orderDiscovery(currentDiscovery.rankings, currentDiscovery).map(({ id }) => outfitsById.get(id)).filter(Boolean) : outfits;

  if (!resources.current) resources.current = {
    discovery: createViewResource({
      load: (signal) => request(`${API}/discovery/config`, { signal }),
      onValue: setDiscoveryConfig,
      onError: () => setDiscoveryConfig(null),
    }),
    collection: createViewResource({
      load: (signal) => request(API, { signal }),
      onValue: (value) => { setOutfits(value.outfits || []); setLoadError(""); },
      onError: (error) => setLoadError(uiErrorMessage(error)),
      onLoading: (value) => { if (mounted.current) setLoading(value); },
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

  const refreshCollection = useCallback(() => resources.current.collection.refresh({ force: true }), []);
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
  const openJob = (id) => { setActionError(""); setModal({ type: "job", id }); };
  const startGeneration = (body) => mutate("create", `${API}/jobs`, body, (job) => { if (isActive.current) setModal({ type: "job", id: job.id }); });
  const retryJob = (id) => mutate(`retry-${id}`, `${API}/jobs/${encodeURIComponent(id)}/retry`);
  const outfitAction = (jobId, outfitId, action, body) => mutate(`${action}-${outfitId}`, `${API}/jobs/${encodeURIComponent(jobId)}/outfits/${encodeURIComponent(outfitId)}/${action}`, body, action === "approve" ? async () => {
    resources.current.collection.invalidate();
    if (!isActive.current || document.visibilityState === "hidden") return;
    try { await refreshCollection(); } catch { if (mounted.current) setLoadError("The outfit was saved, but the collection couldn't be refreshed. Reload the collection to see it."); }
  } : undefined);
  const currentJobs = jobs.filter(needsAttention);
  const previousJobs = jobs.filter((job) => !needsAttention(job));
  const selectedOutfit = modal?.type === "outfit" ? outfits.find((outfit) => outfit.id === modal.id) : null;
  const selectedJob = modal?.type === "job" ? jobs.find((job) => job.id === modal.id) : null;

  return <main className="outfit-page">
    <header className="outfit-page-heading">
      <div><p className="outfit-count">{loading ? "Your collection" : `${outfits.length} ${outfits.length === 1 ? "outfit" : "outfits"}`}</p><h1>Outfits</h1><p>New ways to wear the pieces you already own.</p></div>
      <button className="outfit-primary" type="button" onClick={() => { setActionError(""); setModal({ type: "generate" }); }} disabled={!config && refreshingConfig}><Plus size={18} aria-hidden="true" />Generate outfits</button>
    </header>
    {outfits.length ? <OutfitFinder config={discoveryConfig} fingerprint={fingerprint} active={active && visible} result={currentDiscovery} onChange={setDiscoveryResult} /> : null}
    {jobsError ? <div className="outfit-page-notice" role="status"><p>{jobsError}</p><button className="outfit-text-button" type="button" onClick={() => { void resources.current.jobs.refresh({ force: true }).catch(() => {}); }}>Refresh</button></div> : null}
    {jobWarnings.length ? <div className="outfit-page-notice" role="alert"><p>Some saved generations need attention.</p><ul>{jobWarnings.map((warning) => <li key={warning}>{uiErrorMessage(warning)}</li>)}</ul></div> : null}
    {actionError && !modal ? <p className="outfit-page-notice outfit-error" role="alert">{actionError}</p> : null}
    {currentJobs.length ? <section className="outfit-jobs" aria-label="Outfits in progress">{currentJobs.map((job) => <JobRow key={job.id} job={job} onOpen={openJob} />)}</section> : null}
    {loadError ? <div className="outfit-page-notice" role="alert"><p>{loadError}</p><button className="outfit-text-button" type="button" onClick={() => { void refreshCollection().catch(() => {}); }}>Reload collection</button></div> : null}
    {loading && !outfits.length ? <p className="outfit-empty" role="status">Loading your outfits…</p> : null}
    {!loading && !loadError && !outfits.length ? <div className="outfit-empty"><h2>Your next look starts here.</h2><p>Generate a collection from your wardrobe, then keep the looks you love.</p></div> : null}
    {displayedOutfits.length ? <section className="outfit-grid" aria-label={currentDiscovery ? "Matching saved outfits" : "Your outfit collection"}>{displayedOutfits.map((outfit, index) => <button key={outfit.id} className="outfit-card" type="button" onClick={() => setModal({ type: "outfit", id: outfit.id })} aria-label={`View ${outfit.name}`}><div className="outfit-card-photo"><Photo src={outfit.image} alt={`${outfit.name}, modelled outfit`} priority={index < 3} /></div><div className="outfit-card-caption"><h2>{outfit.name}</h2><ArrowRight size={19} aria-hidden="true" /><p>{occasionText(outfit)}</p></div></button>)}</section> : null}
    {previousJobs.length ? <details className="outfit-history"><summary>Previous generations <span>({previousJobs.length})</span></summary>{previousJobs.map((job) => <JobRow key={job.id} job={job} onOpen={openJob} />)}</details> : null}
    {active && modal?.type === "generate" ? <OutfitModal title="Generate outfits" className="outfit-generate-modal" onClose={closeModal}><GenerateForm config={config} configError={configError} refreshing={refreshingConfig} onRefresh={refreshConfig} busy={!!busyKey} error={actionError} onSubmit={startGeneration} /></OutfitModal> : null}
    {active && selectedOutfit ? <OutfitModal title={selectedOutfit.name} onClose={closeModal}><OutfitDetails outfit={selectedOutfit} itemsById={itemsById} visible={visible}>{discoveryConfig?.ready ? <OwnedItemSwaps key={selectedOutfit.id} outfit={selectedOutfit} itemsById={itemsById} fingerprint={fingerprint} active={visible} /> : null}</OutfitDetails></OutfitModal> : null}
    {active && selectedJob ? <OutfitModal title={`${selectedJob.count} outfit ${selectedJob.count === 1 ? "idea" : "ideas"}`} className="outfit-review-modal" onClose={closeModal}><ReviewJob key={selectedJob.id} job={selectedJob} itemsById={itemsById} busy={!!busyKey} error={actionError} onAction={outfitAction} onRetryJob={retryJob} visible={visible} /></OutfitModal> : null}
  </main>;
}
