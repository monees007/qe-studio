import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Drawer,
  Group,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { IconPlayerStop, IconSend, IconSparkles, IconTrash, IconX } from '@tabler/icons-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import { apiStream, errMsg } from '../api/client';
import { useSettings } from '../api/hooks';
import { useWorkbench } from '../store/app';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
}

const QUICK = [
  'Review this input for mistakes and convergence issues.',
  'Why did this calculation fail and how do I fix it?',
  'Interpret these results. Are they physically reasonable?',
  'Which parameters should I converge and to what thresholds?',
];

/** Chat with Claude about the current context. Only mounted when AI is available. */
export function AIDrawer() {
  const { aiOpen, closeAI, aiContext, setAIContext, aiPrompt } = useWorkbench();
  const { data: settings } = useSettings();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (aiOpen && aiPrompt) setQ(aiPrompt);
  }, [aiOpen, aiPrompt]);

  useEffect(() => {
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
  }, [msgs]);

  const send = async (question: string) => {
    if (!question.trim() || busy) return;
    const history = msgs.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
    setMsgs((m) => [...m, { role: 'user', content: question }, { role: 'assistant', content: '' }]);
    setQ('');
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      await apiStream(
        '/api/ai/ask',
        { question, context: aiContext, history },
        (ev) => {
          if (ev.type === 'delta') {
            setMsgs((m) => {
              const c = m.slice();
              c[c.length - 1] = { ...c[c.length - 1], content: c[c.length - 1].content + ev.text };
              return c;
            });
          } else if (ev.type === 'error') {
            setMsgs((m) => {
              const c = m.slice();
              c[c.length - 1] = { role: 'assistant', content: ev.message, error: true };
              return c;
            });
          }
        },
        ctrl.signal,
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setMsgs((m) => {
          const c = m.slice();
          c[c.length - 1] = { role: 'assistant', content: errMsg(e), error: true };
          return c;
        });
      }
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  return (
    <Drawer
      opened={aiOpen}
      onClose={closeAI}
      position="right"
      size="lg"
      title={
        <Group gap="xs">
          <IconSparkles size={18} color="var(--mantine-color-violet-6)" />
          <Text fw={600}>AI second opinion</Text>
          <Badge size="xs" color="violet">
            {settings?.ai_model}
          </Badge>
        </Group>
      }
      styles={{ body: { height: 'calc(100% - 60px)', display: 'flex', flexDirection: 'column' } }}
    >
      {!settings?.has_anthropic_key && (
        <Alert color="yellow" mb="sm" title="No API key">
          Add your Claude API key in{' '}
          <Link to="/settings" onClick={closeAI}>
            Settings → AI
          </Link>
          .
        </Alert>
      )}
      {aiContext.length > 0 && (
        <Group gap={6} mb="xs">
          <Text size="xs" c="dimmed">
            Context sent with each question:
          </Text>
          {aiContext.map((c, i) => (
            <Badge
              key={i}
              size="sm"
              variant="outline"
              rightSection={
                <ActionIcon
                  size={12}
                  variant="transparent"
                  onClick={() => setAIContext(aiContext.filter((_, j) => j !== i))}
                >
                  <IconX size={10} />
                </ActionIcon>
              }
            >
              {c.title || c.kind} · {(c.content.length / 1000).toFixed(1)}k chars
            </Badge>
          ))}
        </Group>
      )}
      <ScrollArea style={{ flex: 1 }} viewportRef={viewport}>
        <Stack gap="sm" pr="sm">
          {msgs.length === 0 && (
            <Stack gap={6}>
              <Text size="sm" c="dimmed">
                Claude can review inputs, explain errors and sanity-check results. Answers can be wrong — verify
                important conclusions.
              </Text>
              {QUICK.map((s) => (
                <Button
                  key={s}
                  variant="default"
                  size="xs"
                  justify="flex-start"
                  onClick={() => send(s)}
                  disabled={!settings?.has_anthropic_key}
                >
                  {s}
                </Button>
              ))}
            </Stack>
          )}
          {msgs.map((m, i) => (
            <div
              key={i}
              style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'stretch',
                maxWidth: m.role === 'user' ? '85%' : '100%',
                background: m.role === 'user' ? 'var(--mantine-color-violet-light)' : undefined,
                padding: m.role === 'user' ? '6px 10px' : 0,
                borderRadius: 8,
              }}
            >
              {m.error ? (
                <Alert color="red" p="xs">
                  {m.content}
                </Alert>
              ) : m.role === 'assistant' ? (
                <div className="qes-md" style={{ fontSize: 14 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content || '…'}</ReactMarkdown>
                </div>
              ) : (
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {m.content}
                </Text>
              )}
            </div>
          ))}
        </Stack>
      </ScrollArea>
      <Stack gap={6} mt="sm">
        <Textarea
          autosize
          minRows={2}
          maxRows={8}
          placeholder="Ask about the attached input/output… (Ctrl+Enter to send)"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(q);
          }}
        />
        <Group justify="space-between">
          <Tooltip label="Clear conversation">
            <ActionIcon variant="subtle" onClick={() => setMsgs([])} disabled={busy}>
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
          {busy ? (
            <Button
              color="red"
              variant="light"
              leftSection={<IconPlayerStop size={14} />}
              onClick={() => abort.current?.abort()}
            >
              Stop
            </Button>
          ) : (
            <Button
              color="violet"
              leftSection={<IconSend size={14} />}
              onClick={() => send(q)}
              disabled={!q.trim() || !settings?.has_anthropic_key}
            >
              Send
            </Button>
          )}
        </Group>
      </Stack>
    </Drawer>
  );
}
