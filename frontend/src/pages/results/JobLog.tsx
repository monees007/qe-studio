import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Card, Group, Select, Stack, Switch, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { openSocket } from '../../api/client';
import { qk } from '../../api/hooks';
import type { Job } from '../../api/types';
import { emptyScf, feedScf, type LiveScfState } from '../../lib/liveScf';
import { LiveScfPlot } from './ScfPlot';
import { FINAL_STATUSES } from './util';

const MAX_BUF = 2 * 1024 * 1024;

interface Buf {
  text: string;
  truncated: boolean;
  scf: LiveScfState;
}

/** Live (WebSocket) view of a step's output, with a live SCF convergence plot for pw.x steps. */
export function JobLog({ job }: { job: Job }) {
  const qc = useQueryClient();
  const [follow, setFollow] = useState<number | null>(null); // null = follow the running step
  const [bufs, setBufs] = useState<Record<number, Buf>>({});
  const [lastStep, setLastStep] = useState<number>(job.current_step || 1);
  const [auto, setAuto] = useState(true);
  const [warning, setWarning] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<number | null>(follow);
  followRef.current = follow;
  const final = FINAL_STATUSES.includes(job.status);

  useEffect(() => {
    let stop = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      const ws = openSocket(`/api/ws/jobs/${job.id}`);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        setBufs({}); // server offsets restart at 0 for a new connection
        ws.send(JSON.stringify({ step: followRef.current ?? undefined }));
      };
      ws.onmessage = (m) => {
        let ev: any;
        try {
          ev = JSON.parse(m.data);
        } catch {
          return;
        }
        if (ev.type === 'log') {
          const step = ev.step as number;
          setLastStep(step);
          setBufs((b) => {
            const cur = b[step] ?? { text: '', truncated: false, scf: emptyScf() };
            let text = cur.text + ev.data;
            let truncated = cur.truncated;
            if (text.length > MAX_BUF) {
              const cut = text.indexOf('\n', text.length - MAX_BUF);
              text = text.slice(cut >= 0 ? cut + 1 : text.length - MAX_BUF);
              truncated = true;
            }
            return { ...b, [step]: { text, truncated, scf: feedScf(cur.scf, ev.data) } };
          });
        } else if (ev.type === 'status' && ev.job) {
          const j = ev.job as Job;
          qc.setQueryData(qk.job(j.id), (old: Job | undefined) => (old ? { ...old, ...j, steps: old.steps } : old));
        } else if (ev.type === 'warning') {
          setWarning(ev.message);
        } else if (ev.type === 'error') {
          setWarning(ev.message);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stop) retry = setTimeout(connect, 2500);
      };
    };
    connect();
    return () => {
      stop = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [job.id, qc]);

  const shown = follow ?? lastStep;
  const buf = bufs[shown];
  const step = job.steps[shown - 1];

  useEffect(() => {
    if (auto && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [buf?.text, auto]);

  const choose = (v: string | null) => {
    const n = v === 'follow' || v === null ? null : Number(v);
    setFollow(n);
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ step: n ?? undefined }));
  };

  const stepOptions = useMemo(
    () => [
      { value: 'follow', label: final ? 'Last step' : 'Follow running step' },
      ...job.steps.map((s, i) => ({
        value: String(i + 1),
        label: `${i + 1}. ${s.label || s.program} (${s.output_name})`,
      })),
    ],
    [job.steps, final],
  );

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="wrap">
        <Group gap="xs">
          <Select
            size="xs"
            w={340}
            data={stepOptions}
            value={follow === null ? 'follow' : String(follow)}
            onChange={choose}
            allowDeselect={false}
          />
          <Badge color={connected ? 'teal' : 'gray'} variant="dot">
            {connected ? 'live' : 'connecting…'}
          </Badge>
          {step && (
            <Text size="xs" c="dimmed" className="qes-mono">
              {step.cwd !== '.' ? `${step.cwd}/` : ''}
              {step.output_name}
            </Text>
          )}
        </Group>
        <Switch size="xs" label="auto-scroll" checked={auto} onChange={(e) => setAuto(e.currentTarget.checked)} />
      </Group>
      {warning && (
        <Alert color="yellow" withCloseButton onClose={() => setWarning(null)}>
          {warning}
        </Alert>
      )}
      {step?.program === 'pw.x' && buf && buf.scf.total > 0 && (
        <Card p="xs">
          <Group justify="space-between" mb={2}>
            <Text size="sm" fw={500}>
              Live SCF convergence
            </Text>
            <Text size="xs" c="dimmed">
              {buf.scf.total} iterations · {buf.scf.steps.length} ionic step(s)
              {buf.scf.notConverged ? ' · NOT converged' : ''}
            </Text>
          </Group>
          <LiveScfPlot state={buf.scf} />
        </Card>
      )}
      {buf?.truncated && (
        <Text size="xs" c="dimmed">
          Earlier output truncated in the browser (the full file is kept on the target / in Files).
        </Text>
      )}
      <div
        ref={logRef}
        className="qes-log"
        style={{ height: 520 }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (!atBottom && auto) setAuto(false);
        }}
      >
        {buf?.text ||
          (job.status === 'queued' || job.status === 'submitting' ? 'Waiting for the job to start…' : 'No output yet.')}
      </div>
    </Stack>
  );
}
