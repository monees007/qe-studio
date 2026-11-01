import { useEffect, useRef } from 'react';
import { Badge, Button, Group, Loader, Progress, Stack, Text, Tooltip } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useAIAvailable, useTask } from '../api/hooks';
import type { AIContextItem } from '../api/types';
import { STATUS_COLOR } from '../lib/format';
import { useWorkbench } from '../store/app';

export function StatusBadge({ status, size = 'sm' }: { status: string; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const running = status === 'running' || status === 'submitting';
  return (
    <Badge
      color={STATUS_COLOR[status] ?? 'gray'}
      size={size}
      variant={running ? 'filled' : 'light'}
      leftSection={running ? <Loader size={8} color="white" /> : undefined}
    >
      {status}
    </Badge>
  );
}

/**
 * "Ask AI" button. Renders nothing when AI features are switched off, so callers can
 * place it anywhere without checking the global switch themselves.
 */
export function AskAIButton({
  context,
  prompt,
  label = 'Ask AI',
  size = 'xs',
  variant = 'light',
}: {
  context: AIContextItem[] | (() => AIContextItem[]);
  prompt?: string;
  label?: string;
  size?: 'xs' | 'sm' | 'md';
  variant?: 'light' | 'subtle' | 'outline' | 'filled';
}) {
  const available = useAIAvailable();
  const openAI = useWorkbench((s) => s.openAI);
  if (!available) return null;
  return (
    <Tooltip label="Get a second opinion from Claude (sends the shown context to the Claude API)">
      <Button
        size={size}
        variant={variant}
        color="violet"
        leftSection={<IconSparkles size={14} />}
        onClick={() => openAI(typeof context === 'function' ? context() : context, prompt)}
      >
        {label}
      </Button>
    </Tooltip>
  );
}

/** Live view of a backend background task (downloads, installs). */
export function TaskProgress({
  taskId,
  onDone,
}: {
  taskId: string | null;
  onDone?: (ok: boolean, result: any) => void;
}) {
  const { data } = useTask(taskId);
  const done = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (data && data.status !== 'running' && !done.current) {
      done.current = true;
      onDone?.(data.status === 'done', data.result);
    }
  }, [data, onDone]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [data?.log.length]);
  if (!taskId) return null;
  return (
    <Stack gap={6}>
      <Group justify="space-between">
        <Text size="sm" fw={500}>
          {data?.title ?? 'Starting…'}
        </Text>
        {data && (
          <StatusBadge status={data.status === 'running' ? 'running' : data.status === 'done' ? 'done' : 'failed'} />
        )}
      </Group>
      {data?.progress != null && data.status === 'running' && (
        <Progress value={data.progress * 100} animated size="sm" />
      )}
      <div ref={logRef} className="qes-log" style={{ maxHeight: 220 }}>
        {(data?.log ?? []).join('\n') || ' '}
      </div>
      {data?.error && (
        <Text c="red" size="sm">
          {data.error}
        </Text>
      )}
    </Stack>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Stack align="center" gap="xs" py="xl">
      <Text fw={600}>{title}</Text>
      {children && (
        <Text c="dimmed" size="sm" ta="center" maw={520}>
          {children}
        </Text>
      )}
      {action}
    </Stack>
  );
}
