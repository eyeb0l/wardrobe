import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Plus, Trash, X } from "@phosphor-icons/react";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { GarmentWearControls } from "./garment-wear-controls.jsx";
import { useOutfitCollection } from "./outfit-collection.mjs";
import { usePlanningDays } from "./planning-days.mjs";
import { WardrobeRediscovery, GarmentRediscovery } from "./wardrobe-rediscovery.jsx";
import { SetupFlow } from "./setup-flow.jsx";

import { uiErrorMessage } from "./ui-error.mjs";

import { wardrobeRequest, migrateBrowserEdits } from "./wardrobe-sync.mjs";
import { compareWardrobeItems, moveWithinCategory } from "../shared/wardrobe-order.mjs";
import { garmentAvailability, inLaundry } from "../shared/garment-availability.mjs";
import { ReorderableItem } from "./reorderable-item.jsx";

const OutfitView = lazy(() => import("./outfit-view.jsx").then((module) => ({ default: module.OutfitView })));
const ShoppingView = lazy(() => import("./shopping-view.jsx").then((module) => ({ default: module.ShoppingView })));

const TYPES = [
  { id: "all", label: "All" },
  { id: "upperbody", label: "Tops", singular: "Top" },
  { id: "dresses", label: "Dresses", singular: "Dress" },
  { id: "wholebody_up", label: "Jackets", singular: "Jacket" },
  { id: "lowerbody", label: "Bottoms", singular: "Bottom" },
  { id: "accessories_up", label: "Accessories", singular: "Accessory" },
  { id: "shoes", label: "Shoes", singular: "Shoes" },
];

const TYPE_MAP = Object.fromEntries(TYPES.map((type) => [type.id, type]));


function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(first, second) {
  return Math.sqrt(
    ((first.red - second.red) ** 2)
    + ((first.green - second.green) ** 2)
    + ((first.blue - second.blue) ** 2),
  );
}

function extractPalette(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 72;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const buckets = new Map();

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 72) continue;

    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const key = `${Math.round(red / 28)}-${Math.round(green / 28)}-${Math.round(blue / 28)}`;
    const current = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
    current.red += red;
    current.green += green;
    current.blue += blue;
    current.count += 1;
    buckets.set(key, current);
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      red: Math.round(bucket.red / bucket.count),
      green: Math.round(bucket.green / bucket.count),
      blue: Math.round(bucket.blue / bucket.count),
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);

  const selected = [];
  for (const color of ranked) {
    if (selected.every((existing) => colorDistance(existing, color) > 38)) selected.push(color);
    if (selected.length === 5) break;
  }

  return selected.map((color) => rgbToHex(color.red, color.green, color.blue));
}

function buildSamplingCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  return canvas;
}

function sampleImageColor(image, canvas, event) {
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const imageX = Math.floor((event.clientX - bounds.left - offsetX) / scale);
  const imageY = Math.floor((event.clientY - bounds.top - offsetY) / scale);

  if (imageX < 0 || imageY < 0 || imageX >= canvas.width || imageY >= canvas.height) return null;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (let radius = 0; radius <= 18; radius += 2) {
    const startX = Math.max(0, imageX - radius);
    const startY = Math.max(0, imageY - radius);
    const width = Math.min(canvas.width - startX, (radius * 2) + 1);
    const height = Math.min(canvas.height - startY, (radius * 2) + 1);
    const data = context.getImageData(startX, startY, width, height).data;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 96) return rgbToHex(data[index], data[index + 1], data[index + 2]);
    }
  }

  return null;
}

function GalleryItem({ item, selected, onOpen, rearranging }) {
  const type = TYPE_MAP[item.part]?.singular || "wardrobe item";
  const Tag = rearranging ? "div" : "button";

  return (
    <Tag
      className={`gallery-item${selected ? " selected" : ""}`}
      type={rearranging ? undefined : "button"}
      onClick={rearranging ? undefined : () => onOpen(item.id)}
      aria-label={rearranging ? undefined : `View ${item.name || type}`}
      aria-pressed={rearranging ? undefined : selected}
      data-testid={`wardrobe-item-${item.id}`}
    >
      <OptimizedImage
        draggable={false}
        src={item.thumbnail || item.image}
        alt=""
        sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 180px"
        breakpoints={[120, 180, 240, 320, 480]}
      />
      {inLaundry(item) ? <span className="availability-badge">In laundry</span> : null}
    </Tag>
  );
}

function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const nextTag = input.trim().replace(/^#/, "");
    if (!nextTag || tags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())) return;
    onChange([...tags, nextTag]);
    setInput("");
  };

  return (
    <div className="tag-editor">
      <div className="editable-tags">
        {tags.map((tag) => (
          <span className="editable-tag" key={tag}>
            {tag}
            <button type="button" onClick={() => onChange(tags.filter((existing) => existing !== tag))} aria-label={`Remove ${tag}`}>
              <X size={12} weight="regular" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag();
            }
          }}
          placeholder="Add a detail"
          aria-label="Add detail tag"
        />
        <button type="button" onClick={addTag} disabled={!input.trim()} aria-label="Add detail">
          <Plus size={15} weight="regular" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ColorControl({ label, field, value, palette, onChange, sampling, setSampling, optional = false, onClear, onAdd }) {
  if (optional && !value) {
    return (
      <div className="color-slot empty-color-slot">
        <div className="color-slot-heading">
          <span>{label}</span>
          <small>Optional</small>
        </div>
        <p>Add one if this piece has a second colour.</p>
        <button className="add-secondary-button" type="button" onClick={onAdd}>Add secondary colour</button>
      </div>
    );
  }

  return (
    <div className="color-slot">
      <div className="color-slot-heading">
        <span>{label}</span>
        {optional && <button type="button" onClick={onClear}>Remove</button>}
      </div>
      <label className="selected-color-control">
        <input
          type="color"
          value={value || "#9a9286"}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`Choose ${label.toLowerCase()}`}
        />
        <span className="selected-color-copy">
          <small>Change colour</small>
          <strong>{value || "Custom"}</strong>
        </span>
      </label>
      <div className="suggestion-heading">
        <span>From this photo</span>

      </div>
      <div className="palette" aria-label={`${label} suggestions from photo`}>
        {palette.map((color) => (
          <button
            type="button"
            key={color}
            className={value?.toLowerCase() === color.toLowerCase() ? "active" : ""}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
            aria-label={`Use ${color} as ${label.toLowerCase()}`}
            title={color}
          />
        ))}
      </div>
      <button
        className={`sample-button${sampling === field ? " active" : ""}`}
        type="button"
        onClick={() => setSampling((current) => current === field ? null : field)}
      >
        {sampling === field ? "Cancel" : "Pick from photo"}
      </button>
    </div>
  );
}

function ItemEditor({ draft, setDraft, palette, sampling, setSampling, sampleStatus }) {
  const suggestedSecondary = palette.find((color) => color.toLowerCase() !== draft.color?.toLowerCase()) || "#9a9286";

  return (
    <div className="item-editor">
      <label className="field">
        <span>Name</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder={TYPE_MAP[draft.part]?.singular || "Wardrobe item"}
        />
      </label>

      <label className="field">
        <span>Category</span>
        <select value={draft.part} onChange={(event) => setDraft((current) => ({ ...current, part: event.target.value }))}>
          {TYPES.slice(1).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
        </select>
      </label>

      <label className="field"><span>Availability</span><select value={draft.availability} onChange={event => setDraft(current => ({ ...current, availability: event.target.value }))}><option value="ready">Ready</option><option value="laundry">In laundry</option></select></label>

      <fieldset className="color-field">
        <legend>Colours</legend>
        <div className="colors-editor">
          <ColorControl
            label="Primary colour"
            field="primary"
            value={draft.color}
            palette={palette}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
            sampling={sampling}
            setSampling={setSampling}
          />
          <ColorControl
            label="Secondary colour"
            field="secondary"
            value={draft.secondaryColor}
            palette={palette}
            onChange={(secondaryColor) => setDraft((current) => ({ ...current, secondaryColor }))}
            sampling={sampling}
            setSampling={setSampling}
            optional
            onClear={() => setDraft((current) => ({ ...current, secondaryColor: null }))}
            onAdd={() => setDraft((current) => ({ ...current, secondaryColor: suggestedSecondary }))}
          />
        </div>
        <p className="color-help" aria-live="polite">{sampling ? `Select a point on the garment photo to pick the ${sampling} colour.` : sampleStatus || "Choose a swatch or pick a colour from the garment photo."}</p>
      </fieldset>

      <div className="field details-field">
        <span>Details</span>
        <TagEditor tags={draft.tags} onChange={(tags) => setDraft((current) => ({ ...current, tags }))} />
      </div>
    </div>
  );
}

function ItemViewer({ item, onClose, onSave, onDelete, onRegenerate, onStyle, onViewOutfits, rediscovery, wearActions }) {
  const closeButtonRef = useRef(null);
  const dialogRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [revision, setRevision] = useState(item.revision);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])], availability: garmentAvailability(item) });
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const type = TYPE_MAP[item.part]?.singular || "Wardrobe item";
  const hasModeledImage = Boolean(item.modeledImage);
  const pieceRotation = useMemo(() => {
    const hash = [...item.id].reduce((total, character) => total + character.charCodeAt(0), 0);
    return `${(hash % 9) - 4}deg`;
  }, [item.id]);

  const isDirty = useMemo(() => {
    const normalizedTags = (tags) => tags.map((tag) => tag.trim()).filter(Boolean);
    return JSON.stringify({
      name: draft.name.trim(),
      part: draft.part,
      color: draft.color?.toLowerCase() || null,
      secondaryColor: draft.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(draft.tags),
      availability: draft.availability,
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      part: item.part,
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
      availability: garmentAvailability(item),
    });
  }, [draft, item]);

  const nudgeUnsaved = useCallback(() => {
    setCloseBlocked(true);
    setShaking(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShaking(true));
    });
    clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 420);
  }, []);

  const requestClose = useCallback(() => {
    if (isDirty) nudgeUnsaved();
    else onClose();
  }, [isDirty, nudgeUnsaved, onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      document.body.classList.remove("viewer-open");
      clearTimeout(shakeTimerRef.current);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!isDirty) setCloseBlocked(false);
  }, [isDirty]);

  const cancelEditing = () => {
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])], availability: garmentAvailability(item) });
    setSampling(null);
    setSampleStatus("");
    onClose();
  };

  const saveEditing = async () => {
    setSaving(true); setSaveError("");
    try {
      const saved = await onSave({ ...item, ...draft, revision, name: draft.name.trim(), tags: draft.tags.map(tag => tag.trim()).filter(Boolean) });
      setRevision(saved.revision);
      setDraft({ name: saved.name || "", part: saved.part, color: saved.color || "#9a9286", secondaryColor: saved.secondaryColor || null, tags: [...(saved.tags || [])], availability: garmentAvailability(saved) });
      setSampling(null);
      setSampleStatus("Changes saved.");
    } catch (error) { setSaveError(error.message); }
    finally { setSaving(false); }
  };

  const deleteSelected = async () => {
    setSaving(true); setSaveError("");
    try { await onDelete(item.id, revision); }
    catch (error) { setSaveError(error.message); }
    finally { setSaving(false); }
  };

  const handleImageLoad = (event) => {
    samplingCanvasRef.current = buildSamplingCanvas(event.currentTarget);
    const extracted = extractPalette(event.currentTarget);
    setPalette([...new Set([...(item.palette || []), ...extracted])].slice(0, 5));
  };

  const handleImageClick = (event) => {
    if (!sampling || !samplingCanvasRef.current) return;
    if (!event.currentTarget.complete || event.currentTarget.currentSrc !== event.currentTarget.src) {
      setSampleStatus("Loading the photo for colour picking…");
      return;
    }
    const color = sampleImageColor(event.currentTarget, samplingCanvasRef.current, event);
    if (!color) {
      setSampleStatus("Choose a point on the garment itself.");
      return;
    }
    const targetField = sampling === "secondary" ? "secondaryColor" : "color";
    setDraft((current) => ({ ...current, [targetField]: color }));
    setPalette((current) => [color, ...current.filter((existing) => existing.toLowerCase() !== color.toLowerCase())].slice(0, 5));
    setSampleStatus(`Updated the ${sampling} colour.`);
    setSampling(null);
  };

  const garmentArtwork = (
    <div
      className={`viewer-art${hasModeledImage ? " viewer-art-caption" : ""}${sampling ? " sampling" : ""}`}
      style={hasModeledImage ? { "--piece-rotation": pieceRotation } : undefined}
    >
      <OptimizedImage
        unoptimized={Boolean(sampling)}
        src={item.image}
        alt={`Selected ${type.toLowerCase()}`}
        sizes={hasModeledImage ? "112px" : "(max-width: 520px) 100vw, 300px"}
        breakpoints={[160, 240, 320, 480, 640]}
        priority
        onLoad={handleImageLoad}
        onClick={handleImageClick}
      />
      {sampling && <span className="sample-hint">Pick a colour</span>}
    </div>
  );

  return (
    <dialog ref={dialogRef} className="viewer-overlay" aria-label="Selected wardrobe item" onCancel={(event) => {
      event.preventDefault();
      if (sampling) setSampling(null);
      else requestClose();
    }} onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <div className="viewer-entry">
    <aside className={`viewer editing${hasModeledImage ? " has-modeled-image" : ""}${shaking ? " shake" : ""}`}>
      <button className="viewer-icon-close" type="button" onClick={requestClose} aria-label="Close viewer" ref={closeButtonRef}>
        <X size={24} weight="light" aria-hidden="true" />
      </button>

      {hasModeledImage ? (
        <>
          <div className="modeled-hero">
            <OptimizedImage
              className="modeled-hero-photo"
              src={item.modeledImage}
              alt={`${draft.name || type} worn by a model`}
              sizes="(max-width: 860px) 100vw, 520px"
              breakpoints={[320, 480, 640, 800, 1040, 1280]}
              quality={82}
              priority
            />
          </div>
          <div className="viewer-heading modeled-heading">
            <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
            {garmentArtwork}
          </div>
        </>
      ) : (
        <>
          <div className="viewer-heading">
            <div>
              <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
            </div>
          </div>
          {garmentArtwork}
        </>
      )}

      <fieldset className="viewer-details editing" disabled={saving} style={{ border: 0, minWidth: 0, margin: 0 }}>
        <GarmentWearControls {...wearActions} ids={[item.id]} unavailable={isDirty ? "Save or discard your garment changes before logging a wear." : wearActions.unavailable} />
        <GarmentRediscovery item={item} {...rediscovery} disabled={isDirty || rediscovery.busy} />
        <div className="viewer-style-action">
          <button className="secondary-button" type="button" disabled={isDirty} title={isDirty ? "Save or discard your changes first" : undefined} onClick={() => onViewOutfits(item)}>View saved outfits with this piece</button>
        </div>
        {["upperbody", "lowerbody", "wholebody_up", "shoes", "accessories_up"].includes(item.part) ? <div className="viewer-style-action">
          <button className="secondary-button" type="button" disabled={isDirty} title={isDirty ? "Save or discard your changes first" : undefined} onClick={() => onStyle(item)}>Style this piece</button>
          <p>{isDirty ? "Save or discard your changes to style this piece." : "Create outfits with this piece in every look."}</p>
        </div> : null}
        <ItemEditor
          draft={draft}
          setDraft={setDraft}
          palette={palette}
          sampling={sampling}
          setSampling={setSampling}
          sampleStatus={sampleStatus}
        />

        <button className="secondary-button modeled-regenerate-button" type="button" disabled={isDirty} title={isDirty ? "Save or discard your changes first" : undefined} onClick={() => onRegenerate(item)}>
          <ArrowCounterClockwise size={15} aria-hidden="true" /> {hasModeledImage ? "Update modelled photo" : "Create modelled photo"}
        </button>
        {saveError && <p className="status error" role="alert">{uiErrorMessage(saveError)}</p>}
        {closeBlocked && <p className="unsaved-notice" role="status">Save or discard changes before closing.</p>}

        <div className="viewer-actions">
          <button className="delete-button" type="button" onClick={deleteSelected}>
            <Trash size={15} weight="regular" aria-hidden="true" /> Delete
          </button>
          <span className="action-spacer" />
          <button className="secondary-button" type="button" onClick={cancelEditing}>{isDirty ? "Discard changes" : "Close"}</button>
          <button className="primary-button" type="button" onClick={saveEditing}>
            <Check size={15} weight="bold" aria-hidden="true" /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </fieldset>
    </aside>
    </div>
    </dialog>
  );
}

export function App() {
  const [setupRequested, setSetupRequested] = useState(0);
  const [route, setRoute] = useState(() => window.location.pathname.replace(/\/$/, "") || "/");
  const [shoppingOpened, setShoppingOpened] = useState(() => window.location.pathname.replace(/\/$/, "") === "/shopping");
  const [outfitsOpened, setOutfitsOpened] = useState(() => window.location.pathname.replace(/\/$/, "") === "/outfits");
  const [items, setItems] = useState([]);
  const collection = useOutfitCollection(route === "/outfits" || (route !== "/shopping" && items.length) ? route : "");
  const planningDays = usePlanningDays();
  const itemsById = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);
  const [regenerationRequest, setRegenerationRequest] = useState(null);
  const [activeType, setActiveType] = useState("all");
  const [availabilityFilter, setAvailabilityFilter] = useState("all");
  const [laundrySelection, setLaundrySelection] = useState([]);
  const [wearSelecting, setWearSelecting] = useState(false);
  const [wearSelection, setWearSelection] = useState([]);
  const [garmentWearBusy, setGarmentWearBusy] = useState(false);
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [availabilityError, setAvailabilityError] = useState("");
  const [availabilityNotice, setAvailabilityNotice] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [outfitRequest, setOutfitRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [wardrobeReadError, setWardrobeReadError] = useState("");
  const [syncNotice, setSyncNotice] = useState("");
  const [rearranging, setRearranging] = useState(false);
  const [orderSaving, setOrderSaving] = useState(false);
  const [orderNeedsRefresh, setOrderNeedsRefresh] = useState(false);
  const [orderError, setOrderError] = useState("");
  const [orderNotice, setOrderNotice] = useState("");
  const [drag, setDrag] = useState(null);
  const requestVersion = useRef(0);
  const mutating = useRef(false);
  const refreshing = useRef(null);

  useEffect(() => { if (route === "/shopping") setShoppingOpened(true); }, [route]);
  useEffect(() => { if (route === "/outfits") setOutfitsOpened(true); }, [route]);

  useEffect(() => {
    const onPopState = () => { setRoute(window.location.pathname.replace(/\/$/, "") || "/"); setSelectedId(null); };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (event, path) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    setSelectedId(null);
    setRoute(path);
    window.scrollTo(0, 0);
  };

  const refreshWardrobe = useCallback(async ({ force = false } = {}) => {
    // A mutation invalidates an older read. Wait for it, then start a new read
    // even while the mutation keeps its controls locked for recovery.
    if (force) await refreshing.current;
    else if (mutating.current || refreshing.current) return;
    const version = ++requestVersion.current;
    const refresh = (async () => {
      try {
        let migrationError = "";
        try { setSyncNotice(await migrateBrowserEdits(window.localStorage)); }
        catch (error) { migrationError = error.message; }
        const loaded = await wardrobeRequest("/api/import/wardrobe");
        if (version !== requestVersion.current) return;
        setItems(loaded);
        setOrderNeedsRefresh(false);
        setError(migrationError);
        setWardrobeReadError("");
      } catch (error) { if (version === requestVersion.current) { setError(error.message); setWardrobeReadError(error.message); } }
      finally { setLoading(false); }
    })();
    refreshing.current = refresh;
    try { await refresh; }
    finally { if (refreshing.current === refresh) refreshing.current = null; }
  }, []);

  useEffect(() => {
    refreshWardrobe();
    const refreshVisible = () => { if (document.visibilityState === "visible") refreshWardrobe(); };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    const timer = setInterval(refreshVisible, 30_000);
    return () => { clearInterval(timer); window.removeEventListener("focus", refreshVisible); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [refreshWardrobe]);

  const rediscoveryUnavailable = loading ? "Loading your wardrobe…" : wardrobeReadError ? "Your wardrobe could not be refreshed." : collection.loading ? "Loading wear history and saved looks…" : collection.loadError ? "Wear history and saved looks could not be refreshed." : "";
  const refreshRediscovery = () => { void collection.refresh().catch(() => {}); void refreshWardrobe(); };
  const openRediscoveredLook = (outfitId, date) => {
    setOutfitRequest({ type: date ? "plan" : "open", outfitId, date, revision: collection.plansRevision });
    setSelectedId(null);
    window.history.pushState({}, "", "/outfits"); setRoute("/outfits"); window.scrollTo(0, 0);
  };

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  const visibleItems = useMemo(() => {
    const filtered = items.filter(item => (activeType === "all" || item.part === activeType) && (availabilityFilter === "all" || garmentAvailability(item) === availabilityFilter));
    return [...filtered].sort(compareWardrobeItems);
  }, [activeType, availabilityFilter, items]);
  const selectedWear = visibleItems.filter(item => wearSelection.includes(item.id));
  const selectedLaundry = visibleItems.filter(item => inLaundry(item) && laundrySelection.includes(item.id));

  const reorderItem = async (id, targetId) => {
    if (mutating.current || orderNeedsRefresh) return;
    const move = moveWithinCategory(items, id, targetId);
    if (!move) return;
    mutating.current = true; ++requestVersion.current;
    setOrderSaving(true); setOrderError(""); setOrderNotice("");
    try {
      const saved = await wardrobeRequest("/api/import/wardrobe/reorder", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(move),
      });
      setItems(saved);
      setOrderNotice(`${items.find(item => item.id === id)?.name || "Piece"} moved to position ${move.ids.indexOf(id) + 1} in ${TYPE_MAP[move.part]?.label.toLowerCase()}. Order saved.`);
    } catch (error) {
      setOrderError(error.message);
      // A failed recovery read must not unlock moves based on stale expectedIds.
      setOrderNeedsRefresh(true);
    }
    finally {
      try { await refreshWardrobe({ force: true }); }
      finally { mutating.current = false; setOrderSaving(false); }
    }
  };

  const retryOrderRefresh = async () => {
    setOrderSaving(true);
    try { await refreshWardrobe(); }
    finally { setOrderSaving(false); }
  };

  const chooseType = (typeId) => {
    setActiveType(typeId);
    setWearSelection([]);
    setLaundrySelection([]);
    setSelectedId(null);
  };

  const changeAvailability = async (ids, availability) => {
    if (mutating.current) throw new Error("A wardrobe change is still saving. Please try again.");
    if (wardrobeReadError) throw new Error("Refresh your wardrobe before changing availability.");
    const selected = ids.map(id => items.find(item => item.id === id));
    if (!ids.length || selected.some(item => !item)) throw new Error("A selected piece is no longer available. Refresh your wardrobe.");
    mutating.current = true; ++requestVersion.current; setAvailabilityBusy(true);
    try {
      const saved = await wardrobeRequest("/api/import/wardrobe/availability", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ availability, items: selected.map(({ id, revision }) => ({ id, revision })) }),
      });
      const updates = new Map(saved.map(item => [item.id, item]));
      setItems(current => current.map(item => updates.get(item.id) || item));
      return saved;
    } finally {
      try { await refreshWardrobe({ force: true }); }
      finally { mutating.current = false; setAvailabilityBusy(false); }
    }
  };

  const changeGarmentWear = async (path, body, removingId) => {
    if (mutating.current) throw new Error("A wardrobe change is still saving. Please try again.");
    if (rediscoveryUnavailable) throw new Error("Refresh your wardrobe and wear history before logging changes.");
    mutating.current = true; setGarmentWearBusy(true);
    collection.resource.invalidate();
    try {
      const saved = await wardrobeRequest(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      collection.resource.invalidate();
      collection.setGarmentWears(saved.garmentWears);
      return saved.event;
    } catch (error) {
      collection.resource.invalidate();
      const recovered = await collection.refresh().catch(() => null);
      if (error.status === 409) await refreshWardrobe({ force: true });
      // Recover an acknowledged-on-disk write whose response was lost. Reusing
      // the request ID is also safe if the recovery read failed.
      const event = recovered?.garmentWears?.find(entry => entry.id === body.requestId);
      if (event) return event;
      if (removingId && recovered && !recovered.garmentWears?.some(entry => entry.id === removingId)) return null;
      throw error;
    } finally { mutating.current = false; setGarmentWearBusy(false); }
  };
  const wearActions = { outfits: collection.outfits, garmentWears: collection.garmentWears, today: planningDays[0], itemsById,
    busy: garmentWearBusy || availabilityBusy || orderSaving, unavailable: rediscoveryUnavailable, onRefresh: refreshRediscovery,
    onLog: body => changeGarmentWear("/api/outfits/garment-wears", body),
    onRemove: id => changeGarmentWear(`/api/outfits/garment-wears/${encodeURIComponent(id)}/remove`, {}, id),
    onAvailabilityChange: changeAvailability, wardrobeError: wardrobeReadError, onRefreshWardrobe: refreshWardrobe };

  const markReady = async () => {
    setAvailabilityError(""); setAvailabilityNotice("");
    try {
      const saved = await changeAvailability(selectedLaundry.map(item => item.id), "ready");
      setLaundrySelection([]);
      setAvailabilityNotice(`${saved.length} ${saved.length === 1 ? "piece is" : "pieces are"} ready to wear.`);
    } catch (error) { setAvailabilityError(error.message); }
  };

  const saveItem = async (updatedItem) => {
    if (mutating.current) throw new Error("A wardrobe change is still saving. Please try again.");
    mutating.current = true; ++requestVersion.current;
    try {
      const changes = Object.fromEntries(["name", "part", "color", "secondaryColor", "tags", "availability"].map(key => [key, updatedItem[key]]));
      const saved = await wardrobeRequest(`/api/import/wardrobe/${encodeURIComponent(updatedItem.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: updatedItem.revision, changes }),
      });
      setItems(current => current.map(item => item.id === saved.id ? saved : item));
      setError("");
      return saved;
    } finally { mutating.current = false; refreshWardrobe(); }
  };

  const deleteItem = async (id, revision) => {
    if (mutating.current) throw new Error("A wardrobe change is still saving. Please try again.");
    mutating.current = true; ++requestVersion.current;
    try {
      await wardrobeRequest(`/api/import/wardrobe/${encodeURIComponent(id)}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision }),
      });
      setItems(current => current.filter(item => item.id !== id));
      setSelectedId(null); setError("");
    } finally { mutating.current = false; refreshWardrobe(); }
  };

  const addImportedItem = useCallback((newItem) => {
    setItems((current) => current.some((item) => item.id === newItem.id) ? current : [...current, newItem]);
  }, []);

  const attachImportedModeledImage = useCallback((jobId, modeledImage) => {
    const id = `import-${jobId}`;
    setItems((current) => current.map((item) => item.id === id ? { ...item, modeledImage } : item));
  }, []);

  return (
    <div className={`app-shell${selectedItem ? " has-selection" : ""}`}>
      <nav className="wardrobe-site-nav" aria-label="Main navigation">
        <a href="/" onClick={(event) => navigate(event, "/")} aria-current={!["/outfits", "/shopping"].includes(route) ? "page" : undefined}>Wardrobe</a>
        <a href="/outfits" onClick={(event) => navigate(event, "/outfits")} aria-current={route === "/outfits" ? "page" : undefined}>Outfits</a>
        <a href="/shopping" onClick={(event) => navigate(event, "/shopping")} aria-current={route === "/shopping" ? "page" : undefined}>Shopping</a>
        <button className="setup-nav-button" type="button" onClick={() => setSetupRequested(value => value + 1)}>Setup & guide</button>
      </nav>
      <SetupFlow requested={setupRequested} />
      {(shoppingOpened || route === "/shopping") ? (
        <div hidden={route !== "/shopping"}>
          <Suspense fallback={<p className="status" role="status">Loading Shopping</p>}>
            <ShoppingView items={items} loading={loading} wardrobeError={error} active={route === "/shopping"} />
          </Suspense>
        </div>
      ) : null}
      {(outfitsOpened || route === "/outfits") ? (
        <div hidden={route !== "/outfits"}>
          <Suspense fallback={<p className="status" role="status">Loading Outfits</p>}>
            <OutfitView collection={collection} items={items} wardrobeLoading={loading} wardrobeError={wardrobeReadError} onRefreshWardrobe={refreshWardrobe} onAvailabilityChange={changeAvailability} availabilityBusy={availabilityBusy || garmentWearBusy} active={route === "/outfits"} generationRequest={outfitRequest} onGenerationHandled={() => setOutfitRequest(null)} />
          </Suspense>
        </div>
      ) : null}
      {["/shopping", "/outfits"].includes(route) ? null : <>
      <main className="gallery-pane">
        <header className="gallery-header">
          <div className="gallery-meta-row">
            <p className="piece-count" role="status">{loading ? "Your wardrobe" : `${visibleItems.length} ${visibleItems.length === 1 ? "piece" : "pieces"}`}</p>
            {!!items.length && <button type="button" className="secondary-button" aria-pressed={rearranging} disabled={orderSaving || availabilityBusy || garmentWearBusy || wearSelecting || availabilityFilter !== "all"} title={availabilityFilter !== "all" ? "Show all availability before rearranging" : undefined} onClick={() => { setRearranging(value => !value); setDrag(null); setOrderNotice(""); }}> {rearranging ? "Done" : "Rearrange"}</button>}
            {items.length ? <button className="secondary-button" type="button" aria-pressed={wearSelecting} disabled={orderSaving || availabilityBusy || garmentWearBusy || rearranging} onClick={() => { setWearSelecting(value => !value); setWearSelection([]); setLaundrySelection([]); }}>{wearSelecting ? "Done selecting" : "Log wear"}</button> : null}
          </div>
          <nav className="category-nav" aria-label="Filter wardrobe by item type">
            {TYPES.map((type) => (
              <button
                key={type.id}
                type="button"
                className={activeType === type.id ? "active" : ""}
                onClick={() => chooseType(type.id)}
                aria-pressed={activeType === type.id}
              >
                {type.label}
              </button>
            ))}
          </nav>
          <div className="wardrobe-availability">
            <label className="field"><span>Availability</span><select value={availabilityFilter} disabled={availabilityBusy || garmentWearBusy} onChange={event => { setWearSelection([]); setWearSelecting(false); setAvailabilityFilter(event.target.value); setLaundrySelection([]); setRearranging(false); setDrag(null); setAvailabilityNotice(""); }}><option value="all">All availability</option><option value="ready">Ready</option><option value="laundry">In laundry</option></select></label>
            {availabilityFilter === "laundry" && !wearSelecting ? <div className="laundry-actions">
              <label><input type="checkbox" disabled={!visibleItems.length || availabilityBusy} checked={!!visibleItems.length && selectedLaundry.length === visibleItems.length} onChange={event => setLaundrySelection(event.target.checked ? visibleItems.map(item => item.id) : [])} />Select all shown</label>
              <button className="secondary-button" type="button" disabled={!selectedLaundry.length || availabilityBusy || !!wardrobeReadError} onClick={markReady}>{availabilityBusy ? "Saving…" : `Mark ready (${selectedLaundry.length})`}</button>
            </div> : null}
          </div>
          {availabilityNotice ? <p className="status" role="status">{availabilityNotice}</p> : null}
          {availabilityError ? <p className="status error" role="alert">{uiErrorMessage(availabilityError)}</p> : null}
          {wardrobeReadError ? <button className="secondary-button" type="button" disabled={availabilityBusy} onClick={() => { void refreshWardrobe(); }}>Refresh wardrobe availability</button> : null}
          {rearranging && <p className="reorder-help" id="reorder-help">Drag pieces or use the arrows to rearrange within each category. Changes save automatically.</p>}
          <p className="reorder-feedback" role="status">{orderSaving ? (orderNeedsRefresh ? "Refreshing wardrobe…" : "Saving order…") : orderNotice}</p>
          {orderError && <p className="reorder-feedback error" role="alert">{uiErrorMessage(orderError)}</p>}
          {orderNeedsRefresh && <div className="reorder-feedback">
            <p>Refresh your wardrobe before rearranging again.</p>
            <button className="secondary-button" type="button" disabled={orderSaving} onClick={retryOrderRefresh}>Refresh wardrobe</button>
          </div>}
        </header>
        {items.length && !rearranging && !wearSelecting && availabilityFilter !== "laundry" ? <WardrobeRediscovery items={visibleItems} outfits={collection.outfits} garmentWears={collection.garmentWears} today={planningDays[0]} unavailable={rediscoveryUnavailable} onRefresh={refreshRediscovery} onOpen={setSelectedId} /> : null}

        {wearSelecting ? <section className="wardrobe-wear-selection" aria-label="Select pieces to log wear">
          <label><input type="checkbox" checked={!!visibleItems.length && selectedWear.length === visibleItems.length} disabled={garmentWearBusy || availabilityBusy || !visibleItems.length} onChange={event => setWearSelection(event.target.checked ? visibleItems.map(item => item.id) : [])} />Select all shown for wear logging</label>
          <GarmentWearControls key={JSON.stringify(selectedWear.map(item => item.id).sort())} {...wearActions} ids={selectedWear.map(item => item.id)} />
        </section> : null}

        {syncNotice && <p className="status" role="status">{syncNotice}</p>}
        {error && <p className="status error">{uiErrorMessage(error)}</p>}
        {!error && loading && <p className="status">Loading wardrobe</p>}
        {!error && !loading && !items.length && <p className="status empty">Add a product link or drop, paste, or choose a photo to import your first piece.</p>}

        {!loading && !!items.length && !visibleItems.length && <p className="status empty">No pieces match these filters. Choose another category or availability.</p>}

        {!!items.length && (
          <section className="gallery-grid" aria-label={`${TYPE_MAP[activeType]?.label || "All"} wardrobe items`}>
            {visibleItems.map((item, index) => rearranging ? (
              <ReorderableItem key={item.id} item={item} busy={orderSaving || orderNeedsRefresh} drag={drag} setDrag={setDrag} onMove={reorderItem}
                previous={visibleItems[index - 1]?.part === item.part ? visibleItems[index - 1] : null}
                next={visibleItems[index + 1]?.part === item.part ? visibleItems[index + 1] : null}>
                <GalleryItem item={item} rearranging />
              </ReorderableItem>
            ) : (
              <div key={item.id} className="availability-item">
                <GalleryItem item={item} selected={selectedId === item.id} onOpen={setSelectedId} />
                {wearSelecting ? <label className="wear-select"><input type="checkbox" checked={wearSelection.includes(item.id)} disabled={garmentWearBusy || availabilityBusy} onChange={event => setWearSelection(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />{item.name || "Select piece"}</label> : null}
                {availabilityFilter === "laundry" && !wearSelecting ? <label className="laundry-select"><input type="checkbox" checked={laundrySelection.includes(item.id)} disabled={availabilityBusy} onChange={event => setLaundrySelection(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />{item.name || "Select piece"}</label> : null}
              </div>
            ))}
          </section>
        )}
      </main>

      {selectedItem && <ItemViewer key={selectedItem.id} item={selectedItem} wearActions={wearActions} rediscovery={{ itemsById, outfits: collection.outfits, garmentWears: collection.garmentWears, days: planningDays, unavailable: rediscoveryUnavailable, onRefresh: refreshRediscovery, onOpen: id => openRediscoveredLook(id), onPlan: openRediscoveredLook, busy: availabilityBusy }} onClose={() => setSelectedId(null)} onSave={saveItem} onDelete={deleteItem} onRegenerate={(item) => { setSelectedId(null); setRegenerationRequest({ id: item.id, requestedAt: Date.now() }); }} onStyle={(item) => {
        setOutfitRequest({ garmentId: item.id });
        setSelectedId(null);
        window.history.pushState({}, "", "/outfits");
        setRoute("/outfits");
        window.scrollTo(0, 0);
      }} onViewOutfits={(item) => {
        setOutfitRequest({ type: "filter", garmentId: item.id });
        setSelectedId(null);
        window.history.pushState({}, "", "/outfits");
        setRoute("/outfits");
        window.scrollTo(0, 0);
      }} />}
      <WardrobeImportFlow regenerationRequest={regenerationRequest} onGarmentApproved={addImportedItem} onModeledApproved={attachImportedModeledImage} onOpenSetup={() => setSetupRequested(value => value + 1)} />
      </>}
    </div>
  );
}
