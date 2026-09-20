import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRight, Plus, X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { formatImageBytes, prepareShoppingImage } from "./shopping-image.mjs";
import "./shopping-view.css";

const EMPTY_ITEMS = [];
const VERDICTS = {
  "good-addition": "A good addition",
  consider: "Worth considering",
  skip: "I'd pass on this one",
  unclear: "A closer look is needed",
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : value.error?.message || "The check couldn't be completed. Please try again.");
  return value;
}

function setupMessage(config) {
  if (!config) return "Shopping settings couldn't be loaded. Refresh to try again.";
  if (!config.hasApiKey) return "Add your API key to the server’s local configuration, restart the server, then refresh settings.";
  if (!config.hasModelReference || !config.modelReferences?.length) return "Add a model reference photo to your local wardrobe setup, then refresh settings.";
  if (!config.ready) return "The shopping service isn't ready. Check the local server configuration, then refresh settings.";
  return "";
}

function Photo({ src, alt, className = "", sizes = "(max-width: 580px) 33vw, 160px" }) {
  const [failedSource, setFailedSource] = useState(null);
  if (!src || failedSource === src) return <div className={`shopping-photo-fallback ${className}`} role="img" aria-label={alt || "Reference photo unavailable"}>Photo unavailable</div>;
  return <OptimizedImage src={src} alt={alt} className={className} onError={() => setFailedSource(src)} sizes={sizes} />;
}

function Assessment({ result, itemsById, headingRef, titleId }) {
  const { assessment, context } = result;
  const pairings = Array.isArray(assessment.pairings) ? assessment.pairings : [];
  const watchOuts = Array.isArray(assessment.watchOuts) ? assessment.watchOuts : [];
  return <section className="shopping-assessment" aria-labelledby={titleId}>
    <header className="shopping-assessment-heading">
      <p className="shopping-eyebrow">{assessment.itemName || "Your potential addition"}</p>
      <h2 id={titleId} ref={headingRef} tabIndex={-1}>{VERDICTS[assessment.verdict] || VERDICTS.unclear}</h2>
      <p className="shopping-assessment-summary">{assessment.summary}</p>
      {context ? <p className="shopping-small shopping-assessment-context">Compared with {context.wardrobeCount} {context.wardrobeCount === 1 ? "wardrobe piece" : "wardrobe pieces"}{context.modelReferenceLabel ? ` and ${context.modelReferenceLabel}` : ""}.</p> : null}
    </header>
    <div className="shopping-assessment-details">
      {[
        ["With your reference", assessment.personalFit],
        ["In your wardrobe", assessment.wardrobeFit],
        ["Anything similar?", assessment.overlap],
      ].map(([label, description]) => description ? <section key={label} className="shopping-assessment-point"><h3>{label}</h3><p>{description}</p></section> : null)}
    </div>
    {watchOuts.length ? <section className="shopping-watch-outs"><h3>Before you decide</h3><ul>{watchOuts.map((point, index) => <li key={index}>{point}</li>)}</ul></section> : null}
    {pairings.length ? <section className="shopping-pairings" aria-label="Ways to wear it with your wardrobe">
      <h3>Wear it with what you own</h3>
      <div className="shopping-pairing-grid">{pairings.map((pairing, index) => <div className="shopping-pairing" key={index}>
        <div className="shopping-pairing-pieces">{(pairing.itemIds || []).map((id) => {
          const item = itemsById.get(id);
          return <figure key={id}>
            {item ? <Photo src={item.thumbnail || item.image} alt={item.name || "Wardrobe piece"} /> : <div className="shopping-photo-fallback">Piece unavailable</div>}
            <figcaption>{item?.name || "No longer in your wardrobe"}</figcaption>
          </figure>;
        })}</div>
        <p>{pairing.reason}</p>
      </div>)}</div>
    </section> : null}
  </section>;
}

export function ShoppingView({ items = EMPTY_ITEMS, loading = false, wardrobeError = "", active = true }) {
  const [config, setConfig] = useState(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState("");
  const [modelReferenceId, setModelReferenceId] = useState("");
  const [prepared, setPrepared] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [imageError, setImageError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [notes, setNotes] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [result, setResult] = useState(null);
  const fileInput = useRef(null);
  const resultHeading = useRef(null);
  const mounted = useRef(false);
  const isActive = useRef(active);
  const prepareVersion = useRef(0);
  const analysisVersion = useRef(0);
  const comparedWardrobe = useRef(null);
  const configController = useRef(null);
  const analysisController = useRef(null);
  const submitting = useRef(false);
  const dragDepth = useRef(0);
  const focusImageChooser = useRef(false);
  const chooseImageButton = useRef(null);
  const id = useId();
  isActive.current = active;

  const references = config?.modelReferences || [];
  const selectedReference = references.find((reference) => reference.id === modelReferenceId);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const wardrobeItems = useMemo(() => items.map(({ id: itemId, name, part, color, secondaryColor, tags }) => ({
    id: itemId,
    name: typeof name === "string" ? name.slice(0, 120) : "",
    part,
    color: typeof color === "string" ? color.slice(0, 20) : null,
    secondaryColor: typeof secondaryColor === "string" ? secondaryColor.slice(0, 20) : null,
    tags: Array.isArray(tags) ? tags.filter((tag) => typeof tag === "string").slice(0, 12).map((tag) => tag.slice(0, 40)) : [],
  })), [items]);
  const wardrobeFingerprint = JSON.stringify(wardrobeItems);
  const latestWardrobe = useRef(wardrobeFingerprint);
  latestWardrobe.current = wardrobeFingerprint;
  const setupProblem = configLoading ? "" : configError || setupMessage(config);
  const wardrobeProblem = wardrobeError ? "Your wardrobe couldn't be loaded. Reload the page to try again." : !loading && !items.length ? "Add a few pieces in the Wardrobe tab first so this check can compare with what you own." : "";
  const canAnalyze = !!prepared && !preparing && !analyzing && !configLoading && !setupProblem && !loading && !wardrobeProblem && !!selectedReference;

  const refreshConfig = useCallback(async () => {
    configController.current?.abort();
    const controller = new AbortController();
    configController.current = controller;
    setConfigLoading(true);
    setConfigError("");
    try {
      const next = await request("/api/shopping/config", { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      setConfig(next);
      setModelReferenceId((current) => current || next.modelReferences?.[0]?.id || "");
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setConfigError(error.message);
    } finally {
      if (mounted.current && !controller.signal.aborted) setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refreshConfig();
    return () => {
      mounted.current = false;
      prepareVersion.current += 1;
      analysisVersion.current += 1;
      configController.current?.abort();
      analysisController.current?.abort();
      submitting.current = false;
    };
  }, [refreshConfig]);

  const clearAnalysis = useCallback(() => {
    analysisVersion.current += 1;
    analysisController.current?.abort();
    submitting.current = false;
    setAnalyzing(false);
    setAnalysisError("");
    setResult(null);
    comparedWardrobe.current = null;
  }, []);

  const chooseFile = useCallback(async (file) => {
    if (!file || submitting.current) return;
    const version = ++prepareVersion.current;
    clearAnalysis();
    setPrepared(null);
    setImageError("");
    setPreparing(true);
    try {
      const image = await prepareShoppingImage(file);
      if (mounted.current && version === prepareVersion.current) setPrepared(image);
    } catch (error) {
      if (mounted.current && version === prepareVersion.current) setImageError(error.message || "This image couldn't be opened. Try another photo.");
    } finally {
      if (mounted.current && version === prepareVersion.current) setPreparing(false);
    }
  }, [clearAnalysis]);

  const acceptFiles = useCallback((files) => {
    if (submitting.current) return;
    if (files.length > 1) {
      setImageError("Choose one image at a time so it's clear which piece to check.");
      return;
    }
    if (files.length) void chooseFile(files[0]);
  }, [chooseFile]);

  useEffect(() => {
    if (!active) {
      dragDepth.current = 0;
      setDragging(false);
      return;
    }
    const paste = (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
      const files = [...(event.clipboardData?.files || [])];
      if (!files.length) return;
      event.preventDefault();
      acceptFiles(files);
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [active, acceptFiles]);

  const removeImage = () => {
    if (submitting.current) return;
    focusImageChooser.current = true;
    prepareVersion.current += 1;
    clearAnalysis();
    setPrepared(null);
    setPreparing(false);
    setImageError("");
    if (fileInput.current) fileInput.current.value = "";
  };

  useEffect(() => {
    if (focusImageChooser.current && !prepared && !preparing) {
      focusImageChooser.current = false;
      if (isActive.current) chooseImageButton.current?.focus();
    }
  }, [prepared, preparing]);

  useEffect(() => {
    if (comparedWardrobe.current !== null && comparedWardrobe.current !== wardrobeFingerprint) {
      setResult(null);
      setAnalysisError("Your wardrobe has changed. Check this piece again for an updated comparison.");
    }
  }, [wardrobeFingerprint]);

  const analyze = async (event) => {
    event.preventDefault();
    if (submitting.current || !canAnalyze) return;
    submitting.current = true;
    const version = ++analysisVersion.current;
    const controller = new AbortController();
    analysisController.current = controller;
    const submittedWardrobe = wardrobeFingerprint;
    comparedWardrobe.current = submittedWardrobe;
    setAnalyzing(true);
    setAnalysisError("");
    setResult(null);
    try {
      const value = await request("/api/shopping/analyze", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          image: prepared.dataUrl,
          modelReferenceId,
          notes: notes.trim(),
          wardrobeItems,
        }),
      });
      if (!value.assessment || !Object.hasOwn(VERDICTS, value.assessment.verdict) || typeof value.assessment.summary !== "string") throw new Error("The response was incomplete. Please try the check again.");
      if (!mounted.current || controller.signal.aborted || version !== analysisVersion.current) return;
      if (latestWardrobe.current !== submittedWardrobe) {
        setAnalysisError("Your wardrobe has changed. Check this piece again for an updated comparison.");
        return;
      }
      setAnalysisError("");
      setResult(value);
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && version === analysisVersion.current) setAnalysisError(error.message || "The check couldn't be completed. Please try again.");
    } finally {
      if (mounted.current && version === analysisVersion.current) {
        submitting.current = false;
        setAnalyzing(false);
      }
    }
  };

  useEffect(() => {
    if (result && active) {
      resultHeading.current?.focus({ preventScroll: true });
      resultHeading.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    }
  }, [result, active]);

  const fileDragged = (event) => active && [...event.dataTransfer.types].includes("Files");
  const imageSize = prepared ? prepared.bytes < prepared.originalBytes * .98 ? `Reduced from ${formatImageBytes(prepared.originalBytes)} to ${formatImageBytes(prepared.bytes)}.` : `${formatImageBytes(prepared.bytes)} · Ready to check.` : "";

  return <main className="shopping-page">
    <header className="shopping-page-heading">
      <h1>Worth adding?</h1>
      <p>Check a piece against your model reference and the wardrobe you already own.</p>
    </header>

    <form className="shopping-form" onSubmit={analyze}>
      <div className="shopping-workspace">
        <section className="shopping-upload-section" aria-labelledby={`${id}-upload-title`}>
          <h2 id={`${id}-upload-title`} className="shopping-section-title">The piece you're considering</h2>
          <div className={`shopping-upload${dragging ? " is-dragging" : ""}${prepared ? " has-image" : ""}`}
            onDragEnter={(event) => { if (fileDragged(event)) { event.preventDefault(); if (!submitting.current) { dragDepth.current += 1; setDragging(true); } } }}
            onDragOver={(event) => { if (fileDragged(event)) { event.preventDefault(); event.dataTransfer.dropEffect = submitting.current ? "none" : "copy"; } }}
            onDragLeave={(event) => { if (fileDragged(event)) { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); } }}
            onDrop={(event) => { if (fileDragged(event)) { event.preventDefault(); dragDepth.current = 0; setDragging(false); acceptFiles([...event.dataTransfer.files]); } }}
          >
            {prepared ? <img className="shopping-upload-preview" src={prepared.dataUrl} alt="The shopping image you selected" /> : preparing ? <div className="shopping-upload-empty" role="status"><div className="shopping-progress-line" aria-hidden="true" /><p className="shopping-upload-title">Preparing your photo…</p><p>Making it smaller while keeping the details.</p><button type="button" className="shopping-text-button" onClick={removeImage}>Cancel</button></div> : <div className="shopping-upload-empty">
              <Plus size={30} weight="light" aria-hidden="true" />
              <p className="shopping-upload-title">Add a screenshot or photo</p>
              <p>A listing you've saved, or a piece you've spotted in a shop.</p>
              <button ref={chooseImageButton} type="button" className="shopping-secondary" onClick={() => fileInput.current?.click()}>Choose image</button>
              <p className="shopping-upload-hint">Or drop an image here or paste it.<br />Large photos are resized before uploading.</p>
            </div>}
            {dragging ? <div className="shopping-drop-message" aria-hidden="true">Drop your image here</div> : null}
          </div>
          <input className="shopping-file-input" ref={fileInput} id={`${id}-file`} type="file" accept="image/*,.heic,.heif" aria-label="Choose a shopping image" disabled={analyzing} tabIndex={-1} onChange={(event) => { acceptFiles([...event.target.files]); event.target.value = ""; }} />
          {prepared ? <div className="shopping-image-details">
            <div><p className="shopping-file-name" title={prepared.name}>{prepared.name}</p><p className="shopping-small">{imageSize}</p></div>
            <div className="shopping-image-actions"><button type="button" className="shopping-text-button" disabled={analyzing} onClick={() => fileInput.current?.click()}>Replace</button><button type="button" className="shopping-remove" onClick={removeImage} disabled={analyzing} aria-label="Remove shopping image"><X size={18} aria-hidden="true" /></button></div>
          </div> : null}
          {imageError ? <p className="shopping-error" role="alert">{imageError}</p> : null}
        </section>

        <div className="shopping-context">
          <label className="shopping-field" htmlFor={`${id}-notes`}>
            <span>What are you looking for? <em>optional</em></span>
            <textarea id={`${id}-notes`} name="notes" rows={3} maxLength={1500} value={notes} disabled={analyzing} placeholder="An everyday layer, something for a wedding… Add the price or any questions about fit." onChange={(event) => { setNotes(event.target.value); if (result) setResult(null); setAnalysisError(""); }} />
            <small>Include anything the photo doesn't tell us.</small>
          </label>

          {references.length ? <fieldset className="shopping-reference-picker" disabled={analyzing || configLoading}>
            <legend>Model reference</legend>
            <div className="shopping-reference-options">{references.map((reference) => <label key={reference.id} className={selectedReference?.id === reference.id ? "selected" : ""}>
              <Photo src={reference.imageUrl} alt="" sizes="104px" />
              <span><input type="radio" name={`${id}-reference`} value={reference.id} checked={selectedReference?.id === reference.id} onChange={() => { setModelReferenceId(reference.id); setResult(null); setAnalysisError(""); }} />{reference.label}</span>
            </label>)}</div>
            <button type="button" className="shopping-text-button shopping-refresh-references" onClick={refreshConfig} disabled={configLoading || analyzing}>{configLoading ? "Refreshing…" : "Refresh photos"}</button>
          </fieldset> : null}
          {!selectedReference && references.length ? <p className="shopping-error" role="status">Choose an available model reference to continue.</p> : null}

          <div className="shopping-wardrobe-context">
            <p>{loading ? "Loading your wardrobe…" : `${items.length} ${items.length === 1 ? "piece" : "pieces"} in your wardrobe`}</p>
            <span>For new combinations, useful additions and anything you already have covered.</span>
          </div>

          {wardrobeProblem ? <div className="shopping-notice" role="status"><p>{wardrobeProblem}</p>{wardrobeError ? <button type="button" className="shopping-text-button" onClick={() => window.location.reload()}>Reload wardrobe</button> : <a className="shopping-text-button" href="/">Go to Wardrobe <ArrowRight size={14} aria-hidden="true" /></a>}</div> : null}
          {setupProblem ? <div className="shopping-notice" role="status"><p>{setupProblem}</p><button type="button" className="shopping-text-button" onClick={refreshConfig} disabled={configLoading || analyzing}>{configLoading ? "Refreshing…" : "Refresh settings"}</button></div> : configLoading ? <p className="shopping-small" role="status">Loading shopping settings…</p> : null}

          <div className="shopping-submit-area">
            <p className="shopping-disclosure">This check sends your image, selected model reference and wardrobe photos to the AI service.</p>
            {analysisError ? <p className="shopping-error" role="alert">{analysisError}</p> : null}
            <button className="shopping-primary" type="submit" disabled={!canAnalyze}>{analyzing ? "Checking your wardrobe…" : analysisError ? "Try again" : result ? "Check again" : "Check this piece"}<ArrowRight size={17} aria-hidden="true" /></button>
            {analyzing ? <div className="shopping-analysis-progress" role="status"><div className="shopping-progress-line" aria-hidden="true" /><p>Looking at the piece, your reference and possible combinations. This can take a minute.</p></div> : null}
            {!prepared && !preparing && !setupProblem && !wardrobeProblem ? <p className="shopping-small shopping-upload-prompt">Add an image to get started.</p> : null}
          </div>
        </div>
      </div>
    </form>

    {result ? <Assessment result={result} itemsById={itemsById} headingRef={resultHeading} titleId={`${id}-assessment-title`} /> : null}
  </main>;
}
