// Saved input documents (list query).
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { qk } from '../../api/hooks';

export interface DocMeta {
  id: string;
  name: string;
  program: string;
  structure_id: string | null;
  created_at: string;
  updated_at: string;
  size: number;
}

export interface DocFull extends DocMeta {
  content: string;
}

export function useDocuments(enabled = true) {
  return useQuery({ queryKey: qk.documents, queryFn: () => apiGet<DocMeta[]>('/api/documents'), enabled });
}
