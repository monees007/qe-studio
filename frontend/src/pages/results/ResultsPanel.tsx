import { Accordion, Alert, Stack, Text } from '@mantine/core';
import type { JobResults } from '../../api/types';
import { EmptyState } from '../../components/common';
import { BandsPlot } from './BandsPlot';
import { ConvergencePlot } from './ConvergencePlot';
import { DensityView } from './DensityView';
import { DosPlot } from './DosPlot';
import { EosPlot } from './EosPlot';
import { PhononPlot } from './PhononPlot';
import { PwSummary } from './PwSummary';
import { RelaxView } from './RelaxView';
import { ScfPlot } from './ScfPlot';

/** Renders the analysis of a job according to its workflow kind. */
export function ResultsPanel({ results, jobId, jobName }: { results: JobResults; jobId: string; jobName?: string }) {
  const { kind, pw } = results;
  const relaxLike = ['relax', 'vc-relax', 'md', 'vc-md'].includes(kind);
  const hasMain = !!(
    results.bands ||
    results.dos ||
    results.phonon ||
    results.convergence ||
    results.eos ||
    results.density
  );
  const pwBlock = pw && (
    <Stack gap="md">
      <PwSummary pw={pw} title={hasMain ? 'Ground-state (SCF) run' : 'pw.x summary'} />
      {(relaxLike || (pw.trajectory?.length ?? 0) > 1) && (
        <RelaxView pw={pw} kind={kind} name={`${jobName ?? 'job'}-final`} />
      )}
      <ScfPlot steps={pw.scf} />
    </Stack>
  );

  return (
    <Stack gap="md">
      {results.error && (
        <Alert color="orange" title="Analysis incomplete">
          {results.error}
        </Alert>
      )}
      {results.bands && <BandsPlot bands={results.bands} />}
      {results.dos && <DosPlot dos={results.dos} />}
      {results.phonon && <PhononPlot phonon={results.phonon} />}
      {results.convergence && <ConvergencePlot conv={results.convergence} />}
      {results.eos && <EosPlot eos={results.eos} />}
      {results.density && <DensityView density={results.density} jobId={jobId} />}
      {pwBlock &&
        (hasMain ? (
          <Accordion variant="separated">
            <Accordion.Item value="scf">
              <Accordion.Control>Ground-state SCF details</Accordion.Control>
              <Accordion.Panel>{pwBlock}</Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        ) : (
          pwBlock
        ))}
      {!pw &&
        !hasMain &&
        !results.error &&
        (kind === 'install' ? (
          <Text size="sm" c="dimmed">
            Installation job: see the Live log and Files tabs (install.log). The connection's QE path is updated
            automatically on success.
          </Text>
        ) : (
          <EmptyState title="No parsed results">
            The outputs of this job could not be analysed automatically. Use the Files tab to inspect them.
          </EmptyState>
        ))}
    </Stack>
  );
}
