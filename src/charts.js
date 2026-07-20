/*
 * Thin wrapper around uPlot for the flight replay dashboard. Original
 * code (not ported from Betaflight blackbox-log-viewer).
 *
 * Colors follow a fixed categorical order (never cycled/reassigned) so
 * the same signal always gets the same color across every chart:
 * slot 1 = "first" series (e.g. roll, or P-term), slot 2 = "second"
 * (pitch, I-term), etc. Palette + ordering validated for colorblind
 * safety (see project's dataviz reference).
 */

const BBLCharts = {};

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Fixed categorical slot colors, read once from CSS custom properties.
BBLCharts.seriesColor = function (slot) {
  return cssVar(`--series-${slot}`);
};

const allCharts = [];

/**
 * seriesDefs: [{ label, slot (1-based color slot), data, dashed (bool) }]
 */
BBLCharts.createLineChart = function (container, title, xData, seriesDefs, opts) {
  opts = opts || {};

  const wrap = document.createElement("div");
  wrap.className = "chart-panel";

  const h = document.createElement("h3");
  h.textContent = title;
  wrap.appendChild(h);

  const plotDiv = document.createElement("div");
  wrap.appendChild(plotDiv);
  container.appendChild(wrap);

  const gridColor = cssVar("--grid");
  const axisColor = cssVar("--axis");

  const series = [
    { label: opts.xLabel || "time (s)" },
    ...seriesDefs.map((s) => ({
      label: s.label,
      stroke: BBLCharts.seriesColor(s.slot),
      width: 2,
      dash: s.dashed ? [6, 4] : undefined,
      points: { show: false },
    })),
  ];

  const uOpts = {
    width: Math.max(wrap.clientWidth - 24, 300),
    height: opts.height || 200,
    padding: [8, 8, 0, 0],
    series,
    axes: [
      { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: axisColor }, values: (u, vals) => vals.map((v) => v.toFixed(1)) },
      { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: axisColor } },
    ],
    scales: { x: { time: false } },
    cursor: { sync: { key: opts.syncKey || "bbl-sync" } },
    legend: { live: true },
  };

  const u = new uPlot(uOpts, [xData, ...seriesDefs.map((s) => s.data)], plotDiv);
  allCharts.push(u);

  window.addEventListener("resize", () => {
    u.setSize({ width: Math.max(wrap.clientWidth - 24, 300), height: opts.height || 200 });
  });

  if (opts.footerHtml) {
    const footer = document.createElement("div");
    footer.className = "chart-footer";
    footer.innerHTML = opts.footerHtml;
    wrap.appendChild(footer);
  }

  return u;
};

BBLCharts.clearAll = function () {
  for (const u of allCharts) u.destroy();
  allCharts.length = 0;
};
