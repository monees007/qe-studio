import { useEffect, useRef, useState } from 'react';
import { Center, Loader, Text, useComputedColorScheme } from '@mantine/core';
import type { Config, Data, Layout } from 'plotly.js';

type PlotlyModule = typeof import('plotly.js-basic-dist-min');
let plotlyPromise: Promise<PlotlyModule> | null = null;
function loadPlotly(): Promise<PlotlyModule> {
  if (!plotlyPromise)
    plotlyPromise = import('plotly.js-basic-dist-min').then((m: any) => (m.default ?? m) as PlotlyModule);
  return plotlyPromise;
}

export interface PlotProps {
  data: Partial<Data>[];
  layout?: Partial<Layout>;
  config?: Partial<Config>;
  height?: number | string;
  filename?: string; // for PNG/SVG export
  onClick?: (ev: any) => void;
}

/** Plotly chart (lazy-loaded), theme-aware, responsive, with high-resolution PNG/SVG export. */
export function Plot({ data, layout, config, height = 420, filename = 'qe-studio-plot', onClick }: PlotProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [lib, setLib] = useState<PlotlyModule | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const scheme = useComputedColorScheme('light');

  useEffect(() => {
    let alive = true;
    loadPlotly()
      .then((m) => alive && setLib(() => m))
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!lib || !ref.current) return;
    const dark = scheme === 'dark';
    const fg = dark ? '#c9c9c9' : '#222';
    const grid = dark ? '#373a40' : '#e9ecef';
    const base: Partial<Layout> = {
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: 'Inter, system-ui, sans-serif', size: 12, color: fg },
      margin: { l: 64, r: 20, t: 36, b: 52 },
      autosize: true,
      hovermode: 'closest',
      legend: { bgcolor: 'rgba(0,0,0,0)' },
    };
    const merged: any = { ...base, ...layout };
    for (const ax of Object.keys(merged)) {
      if (/^[xy]axis\d*$/.test(ax)) {
        merged[ax] = {
          gridcolor: grid,
          zerolinecolor: grid,
          linecolor: fg,
          mirror: true,
          showline: true,
          ticks: 'outside',
          ...merged[ax],
        };
      }
    }
    if (!merged.xaxis)
      merged.xaxis = {
        gridcolor: grid,
        zerolinecolor: grid,
        linecolor: fg,
        mirror: true,
        showline: true,
        ticks: 'outside',
      };
    if (!merged.yaxis)
      merged.yaxis = {
        gridcolor: grid,
        zerolinecolor: grid,
        linecolor: fg,
        mirror: true,
        showline: true,
        ticks: 'outside',
      };
    const cfg: Partial<Config> = {
      responsive: true,
      displaylogo: false,
      toImageButtonOptions: { format: 'png', filename, scale: 3 },
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      ...config,
    };
    lib.react(ref.current, data as Data[], merged, cfg);
    const el = ref.current as any;
    if (onClick) {
      el.removeAllListeners?.('plotly_click');
      el.on?.('plotly_click', onClick);
    }
  }, [lib, data, layout, config, scheme, filename, onClick]);

  useEffect(() => {
    if (!lib || !ref.current) return;
    const el = ref.current;
    const ro = new ResizeObserver(() => lib.Plots.resize(el));
    ro.observe(el);
    return () => {
      ro.disconnect();
      try {
        lib.purge(el);
      } catch {
        /* ignore */
      }
    };
  }, [lib]);

  if (err) return <Text c="red">Plot library failed to load: {err}</Text>;
  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      {!lib && (
        <Center style={{ position: 'absolute', inset: 0 }}>
          <Loader size="sm" />
        </Center>
      )}
      <div ref={ref} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
