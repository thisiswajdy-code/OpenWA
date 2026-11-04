import { useEffect } from 'react';

/**
 * Custom hook to set document title dynamically.
 * Automatically appends " | Scalorus WA" suffix.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} | Scalorus WA`;

    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}
