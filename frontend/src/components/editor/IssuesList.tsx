import { Badge, Group, Loader, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconAlertCircle, IconAlertTriangle, IconCircleCheck, IconInfoCircle } from '@tabler/icons-react';
import type { ValidationResult } from '../../api/types';
import { issueCounts } from './useValidation';

const ICON = {
  error: <IconAlertCircle size={15} color="var(--mantine-color-red-6)" />,
  warning: <IconAlertTriangle size={15} color="var(--mantine-color-yellow-7)" />,
  info: <IconInfoCircle size={15} color="var(--mantine-color-blue-6)" />,
};

export function ValidationBadges({
  result,
  loading,
}: {
  result: ValidationResult | null | undefined;
  loading?: boolean;
}) {
  if (loading && !result) return <Loader size="xs" />;
  if (!result) return null;
  const c = issueCounts(result);
  if (!c.errors && !c.warnings)
    return (
      <Badge color="teal" leftSection={<IconCircleCheck size={12} />}>
        valid
      </Badge>
    );
  return (
    <Group gap={4}>
      {c.errors > 0 && (
        <Badge color="red">
          {c.errors} error{c.errors > 1 ? 's' : ''}
        </Badge>
      )}
      {c.warnings > 0 && (
        <Badge color="yellow">
          {c.warnings} warning{c.warnings > 1 ? 's' : ''}
        </Badge>
      )}
    </Group>
  );
}

export function IssuesList({
  result,
  onJump,
  maxHeight = 180,
}: {
  result: ValidationResult | null | undefined;
  onJump?: (line: number) => void;
  maxHeight?: number;
}) {
  const issues = result?.issues ?? [];
  if (!result) return null;
  if (issues.length === 0) {
    return (
      <Text size="sm" c="teal">
        No problems found by the static checks. (QE may still reject physically unreasonable input.)
      </Text>
    );
  }
  return (
    <ScrollArea.Autosize mah={maxHeight}>
      <Stack gap={2}>
        {issues.map((i, k) => (
          <UnstyledButton
            key={k}
            onClick={() => i.line && onJump?.(i.line)}
            disabled={!i.line}
            style={{ borderRadius: 4, padding: '2px 4px', cursor: i.line ? 'pointer' : 'default' }}
          >
            <Group gap={6} wrap="nowrap" align="flex-start">
              {ICON[i.severity]}
              <Text size="xs" c="dimmed" ff="monospace" w={56} style={{ flexShrink: 0 }}>
                {i.line ? `line ${i.line}` : ''}
              </Text>
              <Text size="sm">{i.message}</Text>
            </Group>
          </UnstyledButton>
        ))}
      </Stack>
    </ScrollArea.Autosize>
  );
}
