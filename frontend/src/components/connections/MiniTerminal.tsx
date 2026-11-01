// Run one-off, non-interactive commands on a connection (diagnostics).
import { useState } from 'react';
import { Button, Code, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import { apiPost, errMsg } from '../../api/client';
import type { Connection } from '../../api/types';

export function MiniTerminal({ conn }: { conn: Connection }) {
  const [cmd, setCmd] = useState('');
  const [out, setOut] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!cmd.trim()) return;
    setBusy(true);
    try {
      const r = await apiPost<{ stdout: string; stderr: string; code: number }>(`/api/connections/${conn.id}/exec`, {
        command: cmd,
        timeout: 120,
      });
      setOut((o) =>
        `${o}$ ${cmd}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}${r.code ? `\n[exit ${r.code}]` : ''}\n`.slice(
          -200000,
        ),
      );
    } catch (e) {
      setOut((o) => `${o}$ ${cmd}\n[error] ${errMsg(e)}\n`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        Runs a non-interactive command on the target (with the connection's environment setup), e.g.{' '}
        <Code>module avail espresso</Code>, <Code>nproc</Code>, <Code>squeue -u $USER</Code>.
      </Text>
      <Group gap="xs">
        <TextInput
          className="qes-mono"
          style={{ flex: 1 }}
          placeholder="command"
          value={cmd}
          onChange={(e) => setCmd(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <Button onClick={run} loading={busy} leftSection={<IconPlayerPlay size={14} />}>
          Run
        </Button>
        <Button variant="subtle" onClick={() => setOut('')}>
          Clear
        </Button>
      </Group>
      {out && (
        <div className="qes-log" style={{ maxHeight: 260 }}>
          {out}
        </div>
      )}
    </Stack>
  );
}
