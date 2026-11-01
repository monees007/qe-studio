// One generated workflow step: editable input with validation badges.
import { useState } from 'react';
import { Accordion, Badge, Group, Text } from '@mantine/core';
import type { StepSpec } from '../../api/types';
import { ValidationBadges } from '../editor/IssuesList';
import { useValidation } from '../editor/useValidation';
import { QEEditor } from '../QEEditor';

export function StepItem({
  step,
  index,
  onChange,
}: {
  step: StepSpec;
  index: number;
  onChange: (s: StepSpec) => void;
}) {
  const program =
    {
      'pw.x': 'pw',
      'ph.x': 'ph',
      'pp.x': 'pp',
      'dos.x': 'dos',
      'projwfc.x': 'projwfc',
      'bands.x': 'bands',
      'q2r.x': 'q2r',
      'matdyn.x': 'matdyn',
    }[step.program] ?? 'pw';
  const [edited, setEdited] = useState(false);
  const { result, loading } = useValidation(edited ? step.input : '', program);
  const validation = edited ? result : (step.validation ?? null);
  return (
    <Accordion.Item value={String(index)}>
      <Accordion.Control>
        <Group gap="xs" wrap="nowrap">
          <Badge variant="filled" size="sm" circle>
            {index + 1}
          </Badge>
          <Text size="sm" fw={500}>
            {step.label}
          </Text>
          <Badge size="xs" variant="outline" ff="monospace">
            {step.program}
          </Badge>
          <Text size="xs" c="dimmed" ff="monospace">
            {step.cwd !== '.' ? `${step.cwd}/` : ''}
            {step.input_name}
          </Text>
          {step.np === 1 && (
            <Badge size="xs" color="gray">
              serial
            </Badge>
          )}
          {edited && (
            <Badge size="xs" color="orange">
              edited
            </Badge>
          )}
          <ValidationBadges result={validation} loading={loading} />
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <QEEditor
          value={step.input}
          program={program}
          height={340}
          issues={validation?.issues}
          onChange={(v) => {
            setEdited(true);
            onChange({ ...step, input: v, validation: null });
          }}
        />
      </Accordion.Panel>
    </Accordion.Item>
  );
}
