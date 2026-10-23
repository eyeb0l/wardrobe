import { useCallback, useEffect, useRef, useState } from 'react';
import { createViewResource } from './view-resource.mjs';
import { wardrobeRequest } from './wardrobe-sync.mjs';
import { uiErrorMessage } from './ui-error.mjs';

// Wardrobe and Outfits share one snapshot and mutation fence. A late focus
// response must not replace a wear or plan just saved in the other view.
export function useOutfitCollection(activeRoute) {
  const [outfits, setOutfits] = useState([]);
  const [plans, setPlans] = useState([]);
  const [plansRevision, setPlansRevision] = useState('initial');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const resource = useRef(null);
  if (!resource.current) resource.current = createViewResource({
    load: signal => wardrobeRequest('/api/outfits', { signal }),
    onValue: value => { setOutfits(value.outfits || []); setPlans(value.plans || []); setPlansRevision(value.plansRevision || 'initial'); setLoadError(''); },
    onError: error => setLoadError(uiErrorMessage(error)),
    onLoading: setLoading,
  });
  const refresh = useCallback(() => resource.current.refresh({ force: true }), []);
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
  return { outfits, setOutfits, plans, setPlans, plansRevision, setPlansRevision, loading, loadError, setLoadError, refresh, resource: resource.current };
}
