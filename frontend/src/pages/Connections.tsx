// Compute connections page: this computer, SSH servers/clusters and Kaggle/Jupyter servers.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Anchor, Button, Group, Loader, Modal, Stack, Text, Title } from '@mantine/core';
import { IconBrandPython, IconPlus, IconServer } from '@tabler/icons-react';
import { useConnections } from '../api/hooks';
import type { Connection } from '../api/types';
import { EmptyState } from '../components/common';
import { ConnectionCard } from '../components/connections/ConnectionCard';
import { ConnectionForm } from '../components/connections/ConnectionForm';

export default function Connections() {
  const { data: conns, isLoading } = useConnections();
  const [adding, setAdding] = useState<Connection['kind'] | null>(null);
  const sorted = useMemo(
    () =>
      [...(conns ?? [])].sort((a, b) =>
        a.kind === 'local' ? -1 : b.kind === 'local' ? 1 : a.name.localeCompare(b.name),
      ),
    [conns],
  );
  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={2}>Connections & QE</Title>
          <Text c="dimmed" size="sm">
            Where calculations run: this computer, SSH servers/clusters (SLURM/PBS), or Kaggle/Jupyter servers.
          </Text>
        </div>
        <Group>
          <Button leftSection={<IconServer size={16} />} onClick={() => setAdding('ssh')}>
            Add SSH server
          </Button>
          <Button leftSection={<IconBrandPython size={16} />} variant="light" onClick={() => setAdding('jupyter')}>
            Add Kaggle / Jupyter
          </Button>
        </Group>
      </Group>
      {isLoading && <Loader />}
      {!isLoading && !sorted.length && (
        <EmptyState
          title="No connections"
          action={
            <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding('ssh')}>
              Add one
            </Button>
          }
        />
      )}
      <Stack>
        {sorted.map((c) => (
          <ConnectionCard key={c.id} conn={c} />
        ))}
      </Stack>
      <Text size="xs" c="dimmed">
        Tip: after adding a connection press <b>Test</b> — QE Studio detects pw.x, MPI and schedulers there. Jobs
        survive restarts of QE Studio and network drops; their state is kept in the job folder on the target. See{' '}
        <Anchor component={Link} to="/jobs">
          Jobs
        </Anchor>
        .
      </Text>
      <Modal
        opened={!!adding}
        onClose={() => setAdding(null)}
        title={adding === 'jupyter' ? 'Add Kaggle / Jupyter server' : 'Add SSH server'}
        size="xl"
      >
        {adding && <ConnectionForm kind={adding} onDone={() => setAdding(null)} />}
      </Modal>
    </Stack>
  );
}
