// One connection: status, test, edit/delete, QE setup and command runner.
import { useState } from 'react';
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Loader,
  Modal,
  Text,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconEdit, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiPost, errMsg } from '../../api/client';
import { notifyError, notifyOk, qk } from '../../api/hooks';
import type { Connection } from '../../api/types';
import { fmtDate } from '../../lib/format';
import { KIND_ICON, type TestResult } from './constants';
import { ConnectionForm } from './ConnectionForm';
import { QESetup } from './QESetup';
import { MiniTerminal } from './MiniTerminal';

export function ConnectionCard({ conn }: { conn: Connection }) {
  const qc = useQueryClient();
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [editing, setEditing] = useState(false);
  const Icon = KIND_ICON[conn.kind];
  const det = conn.config.detected ?? {};

  const runTest = async () => {
    setTesting(true);
    try {
      const r = await apiPost<TestResult>(`/api/connections/${conn.id}/test`);
      setTest(r);
      qc.invalidateQueries({ queryKey: qk.connections });
      if (r.ok) notifyOk(`${conn.name}: connected${r.info?.qe_version ? `, QE ${r.info.qe_version}` : ''}`);
    } catch (e) {
      setTest({ ok: false, error: errMsg(e) });
    } finally {
      setTesting(false);
    }
  };

  const remove = () =>
    modals.openConfirmModal({
      title: `Delete connection “${conn.name}”?`,
      children: (
        <Text size="sm">
          Stored passwords/URLs for it are deleted too. Job records stay; their remote files are not touched.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await apiDelete(`/api/connections/${conn.id}`);
          qc.invalidateQueries({ queryKey: qk.connections });
        } catch (e) {
          notifyError(e);
        }
      },
    });

  const subtitle =
    conn.kind === 'ssh'
      ? `${conn.config.username ? conn.config.username + '@' : ''}${conn.config.host}:${conn.config.port}${conn.config.jump_host ? ` via ${conn.config.jump_host}` : ''}`
      : conn.kind === 'jupyter'
        ? (conn.jupyter_host ?? 'no URL stored')
        : (det.host ?? 'local machine');

  return (
    <Card>
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <Icon size={28} stroke={1.5} />
          <div>
            <Group gap={6}>
              <Text fw={600}>{conn.name}</Text>
              <Badge size="xs" variant="outline">
                {conn.kind}
              </Badge>
              {conn.config.scheduler !== 'direct' && (
                <Badge size="xs" color="grape">
                  {conn.config.scheduler}
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed" className="qes-mono">
              {subtitle}
            </Text>
          </div>
        </Group>
        <Group gap={6}>
          {det.qe_found ? (
            <Badge color="teal">QE {det.qe_version ?? '✓'}</Badge>
          ) : det.programs ? (
            <Badge color="red">no pw.x</Badge>
          ) : null}
          <Button
            size="xs"
            variant="light"
            leftSection={testing ? <Loader size={12} /> : <IconRefresh size={14} />}
            onClick={runTest}
            disabled={testing}
          >
            Test
          </Button>
          <Tooltip label="Edit">
            <ActionIcon variant="subtle" onClick={() => setEditing(true)}>
              <IconEdit size={16} />
            </ActionIcon>
          </Tooltip>
          {conn.kind !== 'local' && (
            <Tooltip label="Delete">
              <ActionIcon variant="subtle" color="red" onClick={remove}>
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Group>
      {test && (
        <Alert
          mt="sm"
          color={test.ok ? 'teal' : 'red'}
          title={test.ok ? 'Connection OK' : 'Connection failed'}
          withCloseButton
          onClose={() => setTest(null)}
        >
          {test.error && <Text size="sm">{test.error}</Text>}
          {test.log?.map((l, i) => (
            <Text key={i} size="xs" className="qes-mono">
              {l}
            </Text>
          ))}
          {test.info?.stderr && (
            <Text size="xs" c="dimmed" className="qes-mono" lineClamp={4}>
              {test.info.stderr}
            </Text>
          )}
        </Alert>
      )}
      <Accordion variant="separated" mt="sm" chevronPosition="left">
        <Accordion.Item value="qe">
          <Accordion.Control>Quantum ESPRESSO setup</Accordion.Control>
          <Accordion.Panel>
            <QESetup conn={conn} onChanged={() => qc.invalidateQueries({ queryKey: qk.connections })} />
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="term">
          <Accordion.Control>Run a command</Accordion.Control>
          <Accordion.Panel>
            <MiniTerminal conn={conn} />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      <Text size="xs" c="dimmed" mt={6}>
        Work dir: <Code>{conn.config.work_root}</Code>
        {conn.config.qe_bin_dir && (
          <>
            {' '}
            · bin: <Code>{conn.config.qe_bin_dir}</Code>
          </>
        )}{' '}
        · updated {fmtDate(conn.updated_at)}
      </Text>
      <Modal opened={editing} onClose={() => setEditing(false)} title={`Edit ${conn.name}`} size="xl">
        <ConnectionForm initial={conn} kind={conn.kind} onDone={() => setEditing(false)} />
      </Modal>
    </Card>
  );
}
