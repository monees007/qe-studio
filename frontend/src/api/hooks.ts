import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { apiDelete, apiGet, apiPost, apiPut, errMsg, openSocket } from './client';
import type {
  AppSettings,
  Connection,
  Job,
  JobResults,
  Meta,
  ProgramSchema,
  PseudoFamily,
  PseudoInfo,
  StructureRecord,
  TaskInfo,
} from './types';

export const qk = {
  meta: ['meta'] as const,
  settings: ['settings'] as const,
  structures: ['structures'] as const,
  structure: (id: string) => ['structure', id] as const,
  documents: ['documents'] as const,
  connections: ['connections'] as const,
  jobs: ['jobs'] as const,
  job: (id: string) => ['job', id] as const,
  results: (id: string) => ['results', id] as const,
  pseudos: ['pseudos'] as const,
  schema: (p: string) => ['schema', p] as const,
  task: (id: string) => ['task', id] as const,
};

export function notifyError(e: unknown, title = 'Error') {
  notifications.show({ color: 'red', title, message: errMsg(e), autoClose: 8000 });
}

export function notifyOk(message: string, title = 'Done') {
  notifications.show({ color: 'teal', title, message, autoClose: 3000 });
}

export const useMeta = () =>
  useQuery({ queryKey: qk.meta, queryFn: () => apiGet<Meta>('/api/meta'), staleTime: 30_000 });
export const useSettings = () =>
  useQuery({ queryKey: qk.settings, queryFn: () => apiGet<AppSettings>('/api/settings') });

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: Partial<AppSettings>) => apiPut<AppSettings>('/api/settings', s),
    onSuccess: (s) => {
      qc.setQueryData(qk.settings, s);
      qc.invalidateQueries({ queryKey: qk.meta });
    },
    onError: (e) => notifyError(e, 'Saving settings failed'),
  });
}

/** True when AI features may be shown anywhere in the UI. */
export function useAIAvailable(): boolean {
  const { data } = useSettings();
  return !!data?.ai_available;
}

export const useStructures = () =>
  useQuery({ queryKey: qk.structures, queryFn: () => apiGet<StructureRecord[]>('/api/structures') });
export const useStructure = (id?: string | null) =>
  useQuery({
    queryKey: qk.structure(id ?? ''),
    queryFn: () => apiGet<StructureRecord>(`/api/structures/${id}`),
    enabled: !!id,
  });

export const useConnections = () =>
  useQuery({ queryKey: qk.connections, queryFn: () => apiGet<Connection[]>('/api/connections'), staleTime: 10_000 });

export const useJobs = (opts?: Partial<UseQueryOptions<Job[]>>) =>
  useQuery({
    queryKey: qk.jobs,
    queryFn: () => apiGet<Job[]>('/api/jobs?limit=500'),
    refetchInterval: 30_000,
    ...opts,
  });

export const useJob = (id?: string) =>
  useQuery({ queryKey: qk.job(id ?? ''), queryFn: () => apiGet<Job>(`/api/jobs/${id}`), enabled: !!id });

export const useJobResults = (id: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: qk.results(id ?? ''),
    queryFn: () => apiGet<JobResults>(`/api/jobs/${id}/results`),
    enabled: !!id && enabled,
    staleTime: 60_000,
    retry: 1,
  });

export const usePseudos = () =>
  useQuery({
    queryKey: qk.pseudos,
    queryFn: () =>
      apiGet<{ pseudos: PseudoInfo[]; defaults: Record<string, string>; families: PseudoFamily[] }>('/api/pseudos'),
  });

export const useSchema = (program: string) =>
  useQuery({
    queryKey: qk.schema(program),
    queryFn: () => apiGet<ProgramSchema>(`/api/qe/schema/${program}`),
    staleTime: Infinity,
    gcTime: Infinity,
  });

export const useTask = (id?: string | null) =>
  useQuery({
    queryKey: qk.task(id ?? ''),
    queryFn: () => apiGet<TaskInfo>(`/api/tasks/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === 'running' || !q.state.data ? 1000 : false),
  });

export function useDeleteStructure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/api/structures/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.structures }),
    onError: (e) => notifyError(e),
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost<Job>(`/api/jobs/${id}/cancel`),
    onSuccess: (j) => {
      qc.invalidateQueries({ queryKey: qk.jobs });
      qc.setQueryData(qk.job(j.id), (old: Job | undefined) => (old ? { ...old, ...j, steps: old.steps } : old));
    },
    onError: (e) => notifyError(e, 'Cancel failed'),
  });
}

/** Global job events (status changes) -> keep react-query caches fresh. */
export function useJobEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let retry = 1000;
    const connect = () => {
      if (stop) return;
      ws = openSocket('/api/ws/events');
      ws.onopen = () => {
        retry = 1000;
      };
      ws.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data);
          if (ev.type === 'job') {
            const j = ev.job as Job;
            qc.setQueryData(qk.jobs, (old: Job[] | undefined) => {
              if (!old) return old;
              const i = old.findIndex((x) => x.id === j.id);
              if (i < 0) return [j, ...old];
              const copy = old.slice();
              copy[i] = { ...old[i], ...j };
              return copy;
            });
            qc.setQueryData(qk.job(j.id), (old: Job | undefined) =>
              old
                ? {
                    ...old,
                    ...j,
                    steps: old.steps.length
                      ? old.steps.map((s, k) => ({ ...s, ...(j.steps[k] ?? {}), input: s.input }))
                      : j.steps,
                  }
                : old,
            );
            if (['done', 'failed', 'cancelled', 'lost'].includes(j.status) && j.fetched) {
              qc.invalidateQueries({ queryKey: qk.results(j.id) });
            }
          } else if (ev.type === 'job_deleted') {
            qc.setQueryData(qk.jobs, (old: Job[] | undefined) => old?.filter((x) => x.id !== ev.id));
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!stop) setTimeout(connect, (retry = Math.min(retry * 2, 15000)));
      };
    };
    connect();
    return () => {
      stop = true;
      ws?.close();
    };
  }, [qc]);
}
