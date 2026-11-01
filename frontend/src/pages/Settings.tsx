import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Divider,
  Group,
  NumberInput,
  PasswordInput,
  Select,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { IconLock, IconSparkles } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut, errMsg } from '../api/client';
import { notifyError, notifyOk, qk, useConnections, useMeta, useSaveSettings, useSettings } from '../api/hooks';
import type { AppSettings } from '../api/types';

const KNOWN_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

export default function Settings() {
  const { data: s } = useSettings();
  const { data: meta } = useMeta();
  const { data: conns } = useConnections();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const models = useQuery({
    queryKey: ['ai-models', s?.has_anthropic_key, s?.ai_available],
    queryFn: () => apiGet<{ models: { id: string; display_name: string }[] }>('/api/ai/models'),
    enabled: !!s?.has_anthropic_key && !!s?.ai_available,
    retry: false,
    staleTime: 600_000,
  });
  const [local, setLocal] = useState<AppSettings | null>(null);
  useEffect(() => {
    if (s) setLocal(s);
  }, [s]);
  if (!s || !local) return null;

  const set = (patch: Partial<AppSettings>) => {
    setLocal({ ...local, ...patch });
    save.mutate(patch);
  };

  const saveKey = async (value: string) => {
    setSavingKey(true);
    try {
      const out = await apiPut<AppSettings>('/api/settings/secrets', { anthropic_api_key: value });
      qc.setQueryData(qk.settings, out);
      qc.invalidateQueries({ queryKey: qk.meta });
      setKey('');
      notifyOk(value ? 'API key saved' : 'API key removed');
    } catch (e) {
      notifyError(e);
    } finally {
      setSavingKey(false);
    }
  };

  const modelOptions = Array.from(
    new Set([...(models.data?.models.map((m) => m.id) ?? []), ...KNOWN_MODELS, local.ai_model]),
  );

  return (
    <Stack maw={860}>
      <Title order={2}>Settings</Title>

      <Card>
        <Group justify="space-between" mb="sm">
          <Group gap="xs">
            <IconSparkles size={20} color="var(--mantine-color-violet-6)" />
            <Title order={4}>AI second opinion (Claude)</Title>
          </Group>
          <Badge color={s.ai_available ? 'violet' : 'gray'}>{s.ai_available ? 'enabled' : 'off'}</Badge>
        </Group>
        {s.ai_hard_disabled ? (
          <Alert color="gray" icon={<IconLock size={16} />} title="Disabled by the administrator">
            AI features are hard-disabled for this installation (<Code>QES_AI_DISABLED=1</Code> or{' '}
            <Code>--disable-ai</Code>). Nothing is ever sent to the Claude API and every AI endpoint refuses requests.
          </Alert>
        ) : (
          <Stack gap="sm">
            <Switch
              size="md"
              checked={local.ai_enabled}
              onChange={(e) => set({ ai_enabled: e.currentTarget.checked })}
              label="Enable AI features"
              description="Master switch: when off, all AI buttons and the assistant disappear everywhere and the backend refuses every AI request."
            />
            <Divider />
            <Group align="flex-end">
              <PasswordInput
                style={{ flex: 1 }}
                label="Claude API key"
                placeholder={s.has_anthropic_key ? '•••••••• (stored)' : 'sk-ant-…'}
                description="Stored in your OS keychain when available, otherwise in a 0600 file in the QE Studio data directory. Never returned to the browser."
                value={key}
                onChange={(e) => setKey(e.currentTarget.value)}
                disabled={!local.ai_enabled}
              />
              <Button
                onClick={() => saveKey(key.trim())}
                disabled={!key.trim() || !local.ai_enabled}
                loading={savingKey}
              >
                Save key
              </Button>
              {s.has_anthropic_key && (
                <Button variant="light" color="red" onClick={() => saveKey('')} loading={savingKey}>
                  Remove
                </Button>
              )}
            </Group>
            <Group grow align="flex-start">
              <Select
                label="Model"
                data={modelOptions}
                value={local.ai_model}
                searchable
                allowDeselect={false}
                onChange={(v) => v && set({ ai_model: v })}
                disabled={!local.ai_enabled}
                description={
                  models.isError
                    ? `Could not list models: ${errMsg(models.error)}`
                    : models.data
                      ? 'Models available to your key'
                      : 'Default list (save a key to load your models)'
                }
              />
              <NumberInput
                label="Max answer tokens"
                min={256}
                max={64000}
                step={256}
                value={local.ai_max_tokens}
                onChange={(v) => typeof v === 'number' && set({ ai_max_tokens: v })}
                disabled={!local.ai_enabled}
              />
            </Group>
            <Switch
              checked={local.ai_send_outputs}
              onChange={(e) => set({ ai_send_outputs: e.currentTarget.checked })}
              disabled={!local.ai_enabled}
              label="Allow attaching output excerpts"
              description="When off, only inputs, structures and parsed summaries are sent — never raw output files."
            />
            <Text size="xs" c="dimmed">
              Privacy: data is sent to the Claude API only when you press Send in the assistant, and only the context
              items shown there. Answers can be wrong; verify important conclusions with convergence tests and the QE
              documentation.
            </Text>
          </Stack>
        )}
      </Card>

      <Card>
        <Title order={4} mb="sm">
          General
        </Title>
        <Stack gap="sm">
          <Group grow>
            <Select
              label="Energy unit"
              data={['eV', 'Ry', 'Ha']}
              value={local.energy_unit}
              allowDeselect={false}
              onChange={(v) => v && set({ energy_unit: v as AppSettings['energy_unit'] })}
            />
            <Select
              label="Default connection"
              data={(conns ?? []).map((c) => ({ value: c.id, label: c.name }))}
              clearable
              value={local.default_connection_id}
              onChange={(v) => set({ default_connection_id: v })}
            />
          </Group>
          <Group grow>
            <NumberInput
              label="Status poll interval (s)"
              min={1}
              max={120}
              value={local.poll_interval_s}
              description="Jobs with an open log are polled at this rate; others every ≥10 s"
              onChange={(v) => typeof v === 'number' && set({ poll_interval_s: v })}
            />
            <NumberInput
              label="Max size per downloaded result file (MB)"
              min={1}
              max={10000}
              value={local.max_download_mb}
              description="Larger files stay on the remote machine (fetch them explicitly)"
              onChange={(v) => typeof v === 'number' && set({ max_download_mb: v })}
            />
          </Group>
          <div>
            <Text size="sm" fw={500} mb={4}>
              Theme
            </Text>
            <SegmentedControl
              data={['auto', 'light', 'dark']}
              value={local.theme}
              onChange={(v) => set({ theme: v as AppSettings['theme'] })}
            />
            <Text size="xs" c="dimmed" mt={4}>
              The header toggle switches immediately; this stores the preference.
            </Text>
          </div>
        </Stack>
      </Card>

      <Card>
        <Title order={4} mb="sm">
          About
        </Title>
        <Stack gap={4}>
          <Text size="sm">
            QE Studio {meta?.version} · Python {meta?.python}
          </Text>
          <Text size="sm">Platform: {meta?.platform}</Text>
          <Text size="sm">
            Data directory: <Code>{meta?.home}</Code>
          </Text>
          <Text size="xs" c="dimmed">
            Parameter documentation is derived from the Quantum ESPRESSO INPUT_* definitions (GPL-2.0). Please cite QE
            and the pseudopotential libraries you use.
          </Text>
        </Stack>
      </Card>
    </Stack>
  );
}
