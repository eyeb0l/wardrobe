import { useEffect, useState } from 'react';
import { planningDays } from '../shared/outfit-plans.mjs';

export function usePlanningDays() {
  const [days, setDays] = useState(planningDays);
  useEffect(() => {
    const update = () => setDays(current => {
      const next = planningDays();
      return current[0] === next[0] ? current : next;
    });
    const timer = window.setInterval(update, 30_000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  return days;
}
