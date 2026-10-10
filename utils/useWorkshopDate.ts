import { useEffect, useState } from 'react';
import { getWorkshopDate } from './studentLifecycle';

export const useWorkshopDate = () => {
  const [today, setToday] = useState(getWorkshopDate);
  useEffect(() => {
    const refresh = () => setToday(getWorkshopDate());
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return today;
};
