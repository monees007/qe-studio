import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  SegmentedControl,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconDownload, IconEye, IconFolder, IconRefresh, IconSearch } from '@tabler/icons-react';
import { apiDownload, apiGet, apiPost, errMsg } from '../../api/client';
import { notifyError, notifyOk } from '../../api/hooks';
import type { FileEntry, Job } from '../../api/types';
import { fmtBytes } from '../../lib/format';

const VIEW_LIMIT = 2_000_000;

/** Browse the job's files: local result cache or the live remote job directory. */
export function FilesBrowser({ job }: { job: Job }) {
  const [source, setSource] = useState<'local' | 'remote'>(job.fetched ? 'local' : 'remote');
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<{ path: string; text: string; size?: number } | null>(null);
  const [loadingView, setLoadingView] = useState(false);
  const [fetching, setFetching] = useState(false);
  const files = useQuery({
    queryKey: ['jobfiles', job.id, source],
    queryFn: () => apiGet<{ entries: FileEntry[] }>(`/api/jobs/${job.id}/files?source=${source}`),
    enabled: source === 'local' || !!job.remote_dir,
    retry: 0,
  });
  const entries = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (files.data?.entries ?? []).filter((e) => !f || e.path.toLowerCase().includes(f));
  }, [files.data, filter]);

  const open = async (e: FileEntry) => {
    setLoadingView(true);
    try {
      const offset = Math.max(0, e.size - VIEW_LIMIT);
      const text = await apiGet<string>(
        `/api/jobs/${job.id}/file?path=${encodeURIComponent(e.path)}&source=${source}&offset=${offset}&max_bytes=${VIEW_LIMIT}`,
      );
      setView({ path: e.path, text: typeof text === 'string' ? text : JSON.stringify(text, null, 1), size: e.size });
    } catch (err) {
      notifyError(err, 'Cannot open file');
    } finally {
      setLoadingView(false);
    }
  };
  const download = (e: FileEntry) =>
    apiDownload(
      `/api/jobs/${job.id}/file?path=${encodeURIComponent(e.path)}&source=${source}&download=true&max_bytes=2000000000`,
      undefined,
      e.path.split('/').pop(),
    ).catch((err) => notifyError(err, 'Download failed'));
  const fetchAll = async (large: boolean) => {
    setFetching(true);
    try {
      const r = await apiPost<{ files: string[]; skipped: { path: string; size: number }[] }>(
        `/api/jobs/${job.id}/fetch?include_large=${large}`,
      );
      notifyOk(
        `${r.files.length} file(s) in the local cache${r.skipped.length ? `, ${r.skipped.length} large file(s) skipped` : ''}`,
      );
      setSource('local');
      files.refetch();
    } catch (err) {
      notifyError(err, 'Fetching results failed');
    } finally {
      setFetching(false);
    }
  };
  const skipped: { path: string; size: number }[] = job.summary?.skipped_large ?? [];

  return (
    <>
      <Group justify="space-between" mb="sm" wrap="wrap">
        <Group gap="xs">
          <SegmentedControl
            size="xs"
            value={source}
            onChange={(v) => setSource(v as 'local' | 'remote')}
            data={[
              { value: 'local', label: 'Local results cache' },
              { value: 'remote', label: 'Remote job directory' },
            ]}
          />
          <TextInput
            size="xs"
            placeholder="filter"
            leftSection={<IconSearch size={12} />}
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            w={180}
          />
          <Tooltip label="Reload listing">
            <ActionIcon variant="default" onClick={() => files.refetch()} loading={files.isFetching}>
              <IconRefresh size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <Group gap="xs">
          <Button
            size="xs"
            variant="light"
            loading={fetching}
            onClick={() => fetchAll(false)}
            disabled={!job.remote_dir}
          >
            Fetch results
          </Button>
          {skipped.length > 0 && (
            <Button size="xs" variant="subtle" loading={fetching} onClick={() => fetchAll(true)}>
              Fetch incl. {skipped.length} large file(s)
            </Button>
          )}
        </Group>
      </Group>
      {source === 'remote' && (
        <Text size="xs" c="dimmed" mb="xs" className="qes-mono">
          {job.remote_dir || 'no remote directory'}
        </Text>
      )}
      {files.error && (
        <Alert color="red" mb="sm">
          {errMsg(files.error)}
        </Alert>
      )}
      {files.isLoading ? (
        <Group justify="center" p="md">
          <Loader size="sm" />
        </Group>
      ) : (
        <Table.ScrollContainer minWidth={560} mah={560}>
          <Table striped highlightOnHover fz="sm" stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Path</Table.Th>
                <Table.Th w={100}>Size</Table.Th>
                <Table.Th w={170}>Modified</Table.Th>
                <Table.Th w={80} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {entries.map((e) => (
                <Table.Tr key={e.path}>
                  <Table.Td className="qes-mono" style={{ fontSize: 12 }}>
                    {e.is_dir ? (
                      <Group gap={4}>
                        <IconFolder size={14} />
                        {e.path}/
                      </Group>
                    ) : (
                      e.path
                    )}
                  </Table.Td>
                  <Table.Td>{e.is_dir ? '' : fmtBytes(e.size)}</Table.Td>
                  <Table.Td>
                    <Text size="xs">{e.mtime ? new Date(e.mtime * 1000).toLocaleString() : ''}</Text>
                  </Table.Td>
                  <Table.Td>
                    {!e.is_dir && (
                      <Group gap={2} wrap="nowrap">
                        <Tooltip label={e.size > VIEW_LIMIT ? `View last ${fmtBytes(VIEW_LIMIT)}` : 'View'}>
                          <ActionIcon variant="subtle" size="sm" onClick={() => open(e)} loading={loadingView}>
                            <IconEye size={14} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Download">
                          <ActionIcon variant="subtle" size="sm" onClick={() => download(e)}>
                            <IconDownload size={14} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
              {!entries.length && (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Text size="sm" c="dimmed">
                      {source === 'local' ? 'No files cached yet — use “Fetch results”.' : 'No files.'}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {skipped.length > 0 && (
        <Text size="xs" c="dimmed" mt="xs">
          Skipped (larger than the download limit in Settings):{' '}
          {skipped.map((s) => `${s.path} (${fmtBytes(s.size)})`).join(', ')}
        </Text>
      )}
      <Modal
        opened={!!view}
        onClose={() => setView(null)}
        size="80%"
        title={
          <Text className="qes-mono" size="sm">
            {view?.path}
          </Text>
        }
      >
        {view && (
          <>
            {view.size !== undefined && view.size > VIEW_LIMIT && (
              <Text size="xs" c="dimmed" mb={4}>
                Showing the last {fmtBytes(VIEW_LIMIT)} of {fmtBytes(view.size)}.
              </Text>
            )}
            <div className="qes-log" style={{ maxHeight: '70vh' }}>
              {view.text}
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
