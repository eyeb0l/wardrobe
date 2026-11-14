import { useCallback, useEffect, useRef, useState } from 'react';
import { createViewResource } from './view-resource.mjs';
import { wardrobeRead } from './wardrobe-sync.mjs';
import { rememberImageVersions } from './image-versions.mjs';
import { uiErrorMessage } from './ui-error.mjs';

// Wardrobe and Outfits share one snapshot and mutation fence. A late focus
// response must not replace a wear or plan just saved in the other view.
export function useOutfitCollection(activeRoute) {
  const [outfits, setOutfits] = useState([]);
  const [garmentWears, setGarmentWears] = useState([]);
  const [plans, setPlans] = useState([]);
  const [plansRevision, setPlansRevision] = useState('initial');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const resource = useRef(null);
  // The validator of the snapshot on screen. Every change made outside a read
  // drops it, so "not modified" can only confirm exactly what is shown.
  const etag = useRef(null);
  const confirmed = useRef(null);
  const failed = useRef(false);
  if (!resource.current) resource.current = createViewResource({
    // "Not modified" confirms the snapshot that validator came with, which
    // callers recovering an uncertain write still need to inspect.
    load: async signal => {
      const read = await wardrobeRead('/api/outfits', etag.current, { signal });
      return read.notModified ? { notModified: true, value: confirmed.current } : read;
    },
    onValue: ({ notModified, value, etag: validator }) => {
      failed.current = false; setLoadError('');
      if (notModified) return;
      rememberImageVersions(value.outfits);
      setOutfits(value.outfits || []); setGarmentWears(value.garmentWears || []); setPlans(value.plans || []); setPlansRevision(value.plansRevision || 'initial');
      etag.current = validator; confirmed.current = value;
    },
    onError: error => { failed.current = true; setLoadError(uiErrorMessage(error)); },
    // A read that carries a validator can only confirm the snapshot on screen
    // or replace it whole, so it runs quietly. Writes still cancel it first.
    onLoading: value => { if (!value || !etag.current || failed.current) setLoading(value); },
  });
  const changed = useRef(null);
  if (!changed.current) {
    const local = setter => update => { etag.current = null; setter(update); };
    changed.current = { setOutfits: local(setOutfits), setGarmentWears: local(setGarmentWears), setPlans: local(setPlans), setPlansRevision: local(setPlansRevision) };
  }
  const refresh = useCallback(() => resource.current.refresh({ force: true }).then(read => read?.value), []);
  useEffect(() => {
    const update = (force = false) => {
      if (activeRoute && document.visibilityState !== 'hidden') void resource.current.refresh({ force }).catch(() => {});
      else resource.current.cancel();
    };
    const focus = () => update(true);
    update();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => { resource.current.cancel(); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [activeRoute]);
  return { outfits, garmentWears, plans, plansRevision, ...changed.current, loading, loadError, setLoadError, refresh, resource: resource.current };
}
