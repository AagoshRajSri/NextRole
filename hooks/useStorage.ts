import { useState, useEffect, useCallback } from 'react';

export function useStorage<T>(key: string, defaultValue: T) {
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    storage.getItem<T>(`local:${key}`).then((stored) => {
      setValue(stored ?? defaultValue);
      setLoading(false);
    });
    
    // Watch for changes (popup stays in sync when background updates storage)
    const unwatch = storage.watch<T>(`local:${key}`, (newVal) => {
      setValue(newVal ?? defaultValue);
    });
    return () => {
      unwatch();
    };
  }, [key]);

  const set = useCallback(async (newVal: T) => {
    setValue(newVal);
    await storage.setItem(`local:${key}`, newVal);
  }, [key]);

  return [value, set, loading] as const;
}
