import { lazy, Suspense, useEffect } from 'react';
import { NavLink as RouterNavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  ActionIcon,
  AppShell,
  Badge,
  Burger,
  Center,
  Group,
  Loader,
  NavLink,
  ScrollArea,
  Text,
  Title,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAtom,
  IconBrandStackshare,
  IconChartLine,
  IconCpu,
  IconFileCode,
  IconFlask2,
  IconHome,
  IconListDetails,
  IconMoon,
  IconPlugConnected,
  IconSettings,
  IconSparkles,
  IconSun,
} from '@tabler/icons-react';
import { useAIAvailable, useJobEvents, useJobs, useMeta, useSettings } from './api/hooks';
import { AIDrawer } from './components/AIDrawer';
import { useWorkbench } from './store/app';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Structures = lazy(() => import('./pages/Structures'));
const InputEditor = lazy(() => import('./pages/InputEditor'));
const Workflows = lazy(() => import('./pages/Workflows'));
const Jobs = lazy(() => import('./pages/Jobs'));
const JobDetail = lazy(() => import('./pages/JobDetail'));
const Analysis = lazy(() => import('./pages/Analysis'));
const Pseudos = lazy(() => import('./pages/Pseudos'));
const Connections = lazy(() => import('./pages/Connections'));
const Settings = lazy(() => import('./pages/Settings'));

const NAV = [
  { to: '/', label: 'Dashboard', icon: IconHome },
  { to: '/structures', label: 'Structures', icon: IconAtom },
  { to: '/editor', label: 'Input editor', icon: IconFileCode },
  { to: '/run', label: 'Workflows & run', icon: IconBrandStackshare },
  { to: '/jobs', label: 'Jobs', icon: IconListDetails },
  { to: '/analysis', label: 'Analyze outputs', icon: IconChartLine },
  { to: '/pseudos', label: 'Pseudopotentials', icon: IconFlask2 },
  { to: '/connections', label: 'Connections & QE', icon: IconPlugConnected },
  { to: '/settings', label: 'Settings', icon: IconSettings },
];

export function App() {
  const [opened, { toggle, close }] = useDisclosure();
  const location = useLocation();
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');
  const ai = useAIAvailable();
  const openAI = useWorkbench((s) => s.openAI);
  const { data: meta } = useMeta();
  const { data: settings } = useSettings();
  useEffect(() => {
    if (settings?.theme) setColorScheme(settings.theme);
  }, [settings?.theme, setColorScheme]);
  const { data: jobs } = useJobs();
  useJobEvents();
  const active = jobs?.filter((j) => ['submitting', 'queued', 'running'].includes(j.status)).length ?? 0;

  return (
    <AppShell
      header={{ height: 52 }}
      navbar={{ width: 230, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="xs">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <img src="/favicon.svg" width={26} height={26} alt="" />
            <Title order={4}>QE Studio</Title>
            {meta && (
              <Text size="xs" c="dimmed">
                v{meta.version}
              </Text>
            )}
          </Group>
          <Group gap="xs">
            {active > 0 && (
              <Tooltip label="Active jobs">
                <Badge
                  component={RouterNavLink}
                  to="/jobs"
                  leftSection={<IconCpu size={12} />}
                  style={{ cursor: 'pointer' }}
                >
                  {active} running
                </Badge>
              </Tooltip>
            )}
            {ai && (
              <Tooltip label="Ask Claude (AI second opinion)">
                <ActionIcon variant="light" color="violet" onClick={() => openAI()} aria-label="Open AI assistant">
                  <IconSparkles size={18} />
                </ActionIcon>
              </Tooltip>
            )}
            <Tooltip label="Toggle color scheme">
              <ActionIcon
                variant="default"
                onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')}
                aria-label="Toggle color scheme"
              >
                {scheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <ScrollArea>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              component={RouterNavLink}
              to={n.to}
              label={n.label}
              leftSection={<n.icon size={18} stroke={1.6} />}
              active={n.to === '/' ? location.pathname === '/' : location.pathname.startsWith(n.to)}
              onClick={close}
              className="qes-nav-link"
            />
          ))}
        </ScrollArea>
      </AppShell.Navbar>
      <AppShell.Main>
        <Suspense
          fallback={
            <Center h={300}>
              <Loader />
            </Center>
          }
        >
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/structures" element={<Structures />} />
            <Route path="/editor" element={<InputEditor />} />
            <Route path="/run" element={<Workflows />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/jobs/:id" element={<JobDetail />} />
            <Route path="/analysis" element={<Analysis />} />
            <Route path="/pseudos" element={<Pseudos />} />
            <Route path="/connections" element={<Connections />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="*"
              element={
                <Center h={300}>
                  <Text>Page not found</Text>
                </Center>
              }
            />
          </Routes>
        </Suspense>
      </AppShell.Main>
      {ai && <AIDrawer />}
    </AppShell>
  );
}
