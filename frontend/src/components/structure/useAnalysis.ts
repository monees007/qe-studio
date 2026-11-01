// Debounced symmetry / lattice analysis of a structure (POST /api/structures/analyze).
import { useEffect, useMemo, useState } from 'react';
import { apiPost, errMsg } from '../../api/client';
import type { Structure, StructureAnalysis } from '../../api/types';

export function useAnalysis(structure: Structure | null, symprec: number) {
  const [data, setData] = useState<StructureAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = useMemo(
    () =>
      structure ? JSON.stringify([structure.cell, structure.pbc, structure.sites.map((s) => [s.species, s.xyz])]) : '',
    [structure],
  );
  useEffect(() => {
    if (!structure || !structure.sites.length) {
      setData(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      apiPost<StructureAnalysis>('/api/structures/analyze', { structure, symprec }, ctrl.signal)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e) => {
          if ((e as Error).name !== 'AbortError') setError(errMsg(e));
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, symprec]);
  return { data, error, loading };
}
