import { Checkbox, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { apiDelete } from '../../api/client';
import { notifyError, notifyOk } from '../../api/hooks';
import type { Job } from '../../api/types';

/** Confirmation dialog for deleting jobs (optionally also their remote directories). */
export function confirmDeleteJobs(jobs: Job[], onDone: () => void) {
  let remote = false;
  modals.openConfirmModal({
    title: jobs.length === 1 ? `Delete job “${jobs[0].name}”?` : `Delete ${jobs.length} jobs?`,
    children: (
      <Stack gap="xs">
        <Text size="sm">
          The job record and its locally cached results are removed. Running jobs are cancelled first.
        </Text>
        <Checkbox
          label="Also delete the job directories on the compute target"
          onChange={(e) => {
            remote = e.currentTarget.checked;
          }}
        />
      </Stack>
    ),
    labels: { confirm: 'Delete', cancel: 'Cancel' },
    confirmProps: { color: 'red' },
    onConfirm: async () => {
      let ok = 0;
      for (const j of jobs) {
        try {
          await apiDelete(`/api/jobs/${j.id}?remote=${remote}`);
          ok += 1;
        } catch (e) {
          notifyError(e, `Deleting ${j.name} failed`);
        }
      }
      if (ok) notifyOk(`${ok} job(s) deleted`);
      onDone();
    },
  });
}
