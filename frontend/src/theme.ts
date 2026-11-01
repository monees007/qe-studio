import { createTheme } from '@mantine/core';

export const theme = createTheme({
  primaryColor: 'blue',
  defaultRadius: 'md',
  fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontFamilyMonospace: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  headings: { fontWeight: '650' },
  components: {
    Card: { defaultProps: { withBorder: true, radius: 'md', padding: 'md' } },
    Paper: { defaultProps: { radius: 'md' } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 300, multiline: true, maw: 420 } },
    Badge: { defaultProps: { variant: 'light' } },
  },
});
