#!/usr/bin/env node
"use strict";

// Offline regression checks. Run here, or copy into the dashboard's tools/:
//   node dashboard-regression.cjs [dashboard-root]
// Browser functions are executed in an isolated Node VM with fake DOM/chart
// objects and an explicit clock. No browser, network, or source writes occur.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const candidates = process.argv[2]
  ? [path.resolve(process.argv[2])]
  : [path.resolve(__dirname, ".."), path.join(__dirname, "WildwoodCrest"), process.cwd()];
const root = candidates.find(dir => fs.existsSync(path.join(dir, "tools/history_data.js")) && fs.existsSync(path.join(dir, "index.html")));
assert(root, "Pass a dashboard root containing index.html and tools/history_data.js");
const readJson = name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const history = readJson("data/peaks_navd88.json");
const annual = readJson("data/annual_flood_counts.json");
const forecast = readJson("data/petss_forecast.json");
const forecastMeta = readJson("data/petss_meta.json");
const helpers = require(path.join(root, "tools/history_data.js"));
const petss = require(path.join(root, "tools/update_petss_forecast.js"));
const plain = value => JSON.parse(JSON.stringify(value));
const crestKey = row => `${new Date(row.crest || row.t).toISOString()}|${Number(row.ft).toFixed(3)}`;
let passed = 0;

function extractFunction(name) {
  const declaration = new RegExp(`^([ \\t]*)(?:async\\s+)?function ${name}\\s*\\(`, "m").exec(html);
  assert(declaration, `Missing dashboard function ${name}`);
  const start = declaration.index + declaration[1].length;
  const closing = new RegExp(`^${declaration[1]}\\}[ \\t]*;?[ \\t]*$`, "gm");
  closing.lastIndex = start;
  let match;
  while ((match = closing.exec(html))) {
    const source = html.slice(start, match.index + match[0].length);
    try { new vm.Script(`(${source.replace(/;\s*$/, "")})`); return source; }
    catch (_) { /* A same-indentation nested brace is not the function end. */ }
  }
  throw new Error(`Could not extract complete function ${name}`);
}

function install(context, names) {
  for (const name of names) vm.runInContext(extractFunction(name), context, { filename: `index.html:${name}` });
}

function makeContext(nowIso) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [nowIso])); }
    static now() { return Date.parse(nowIso); }
  }
  const context = vm.createContext({
    Date: FixedDate, console, URL, AbortSignal,
    TZ: helpers.TZ, GAUGE_TYPE: "USGS", DISPLAY_DATUM: "NAVD88",
    THRESH: { NAVD88: history.thresholdsNAVD88 },
    fmtPartsYMD: new Intl.DateTimeFormat("en-US", { timeZone: helpers.TZ, year: "numeric", month: "2-digit", day: "2-digit" }),
    HIGH_TIDES_NAVD: [], USGS_HISTORY_NAVD: [], HISTORIC_CRESTS_NAVD: [],
    stationAnnualCoverageYears: new Set(), annualCoverageByYear: new Map(),
    ANNUAL_PREDICTIONS_ENABLED: false, YEARS: [], annualMinor: [], annualModerate: [], annualMajor: [], annualSource: [],
    annualPredictionLookup: new Map(),
    DOY_CACHE: null, doyCumChart: null, DOY_CONTROL_YEARS: [], DOY_YEAR_RANGE_KEY: "",
    DOY_VIEW_MODE: "years", DOY_RANGE_START: null, DOY_RANGE_END: null, DOY_PAST_SELECTED_YEAR: null,
    DOY_ANNUAL_FORECAST_ENABLED: false, DOY_FORECAST_DOT_VISIBLE: true,
    DOY_FORECAST_RANGE_VISIBLE: true, DOY_PAST_FORECAST_VISIBLE: true,
    DOY_YEAR_VISIBILITY_INITIALIZED: false, DOY_VISIBILITY_CURRENT_YEAR: null,
    DOY_AVERAGE_VISIBLE: true, DOY_HISTORIC_RANGE_VISIBLE: true,
    resolvePeaksJsonUrl: async () => ({ json: history }),
    buildLiveFloodPeaksSince2026: async () => { throw new Error("Unexpected live fetch in offline test"); },
    applyFilter() {}, updateMonthAveragesFromHistory() {}, renderAnnual() {}, renderDOYCumPanel() {},
    renderDOYYearControls() {}, attachChartZoom() {}, rightFloodAxisConfig: () => ({}),
    document: { getElementById: () => ({ getContext: () => ({}) }) }, window: {},
    Chart: function Chart(_canvas, config) {
      Object.assign(this, config);
      const metadata = new WeakMap();
      this.getDatasetMeta = index => {
        const ds = this.data.datasets[index];
        if(!metadata.has(ds)) metadata.set(ds, { hidden: null });
        return metadata.get(ds);
      };
      this.isDatasetVisible = index => {
        const meta = this.getDatasetMeta(index);
        return typeof meta.hidden === "boolean" ? !meta.hidden : !this.data.datasets[index].hidden;
      };
      this.setDatasetVisibility = (index, visible) => { this.getDatasetMeta(index).hidden = !visible; };
      this.update = () => {};
    }
  });
  vm.runInContext("DOY_SELECTED_YEARS = new Set();", context);
  install(context, ["getESTParts", "annualYearFromEvent", "countEventsFromListForYear", "buildStationAnnualCountsMap",
    "addCoverageYearValue", "addCoverageYearsFromValue", "inferStationAnnualCoverageYears", "buildAnnualArrays",
    "normalizePeaksJson", "historicDateKey", "historicRowPriority", "combinedHistoricRowsNavd",
    "isLeapYear", "calIndex365", "monthStarts365", "doyFloodStageDisplayFt", "doyStageLabel",
    "buildDOYYearDailyCountsFromEvents", "computeDOYStatsFromEvents", "refreshDOYFromHistory",
    "buildYTDSeriesFromEvents", "emptyCurrentYTDSeries", "getDOYSelectableYears", "ensureDOYSelectedRange",
    "normalizeDOYSelectedRange", "getDOYEffectiveSelectedYears", "setDOYRange", "resetDOYForecastVisibility", "initJSONBackedHistory"]);
  return context;
}

async function test(name, body) {
  await body();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

async function main() {
  const context = makeContext(annual.generatedAtUtc);
  await context.initJSONBackedHistory();

  await test("17 original official crests and all March 1962 crests survive the raw catalogue", () => {
    // Baseline identities are intentionally pinned, while new future official
    // crests are allowed. March 7, 1962 is a Lewes measured crest, not a second
    // official USGS crest; neither source may erase the other from the table.
    const baseline = [
      ["1962-03-06", 7.50], ["2001-03-07", 4.26], ["2002-01-31", 3.64],
      ["2003-01-03", 4.58], ["2003-12-06", 4.45], ["2005-05-25", 4.71],
      ["2006-02-12", 4.61], ["2006-10-07", 4.88], ["2008-05-12", 4.81],
      ["2009-06-22", 4.33], ["2009-11-13", 5.03], ["2011-08-27", 5.24],
      ["2012-06-04", 4.89], ["2012-10-29", 6.15], ["2014-04-29", 4.37],
      ["2014-12-09", 4.81], ["2016-01-23", 5.53]
    ];
    const official = history.events.filter(row => row.officialCrestOverride);
    for (const [date, ft] of baseline) assert(official.some(row => row.localDate === date && row.ft === ft && row.sourceStation === "01411382"), `Lost official crest ${date} ${ft}`);
    assert(official.length >= 17);
    const rows = context.combinedHistoricRowsNavd();
    const keys = new Set(rows.map(crestKey));
    for (const row of official) assert(keys.has(crestKey(row)), `Official crest missing from table: ${crestKey(row)}`);
    for (const date of ["1962-03-06", "1962-03-07"]) {
      const raw = history.events.filter(row => row.localDate === date);
      assert(raw.length >= 2, `Expected multiple measured/official crests on ${date}`);
      for (const row of raw) assert(keys.has(crestKey(row)), `Date collapse lost ${crestKey(row)}`);
    }
    const original = context.HISTORIC_CRESTS_NAVD;
    const first = { t: "1962-03-06T14:00:00Z", ft: 6, officialCrestOverride: true };
    const second = { t: "1962-03-06T22:00:00Z", ft: 7, officialCrestOverride: true };
    context.HISTORIC_CRESTS_NAVD = [first, second, { ...first }];
    assert.equal(context.combinedHistoricRowsNavd().length, 2, "Keep distinct same-day crests; merge exact duplicates only");
    context.HISTORIC_CRESTS_NAVD = original;
  });

  await test("annual archive starts in 1919; observed zeros, missing years, and partial coverage remain distinct", () => {
    const endYear = helpers.localParts(annual.generatedAtUtc).y;
    assert.equal(annual.firstYear, 1919);
    assert.equal(annual.lastYear, endYear);
    assert.equal(annual.counts.length, endYear - 1919 + 1);
    const expected = helpers.annualCounts(history.events, history.coverageYears, history.thresholdsNAVD88, endYear);
    assert.deepEqual(annual.counts.map(({ year, minor, moderate, major, available }) => ({ year, minor, moderate, major, available })), expected);
    const days = new Map();
    for (const event of history.events.filter(row => !row.officialCrestOverride)) {
      if (!days.has(event.y)) days.set(event.y, new Set());
      days.get(event.y).add(event.localDate);
    }
    for (const row of annual.counts) {
      const observedDays = days.get(row.year)?.size || 0;
      const fullYearDays = new Date(Date.UTC(row.year, 1, 29)).getUTCMonth() === 1 ? 366 : 365;
      assert.equal(row.observedDays, observedDays, `Coverage mismatch in ${row.year}`);
      assert.equal(row.partial, observedDays < fullYearDays);
      const index = context.YEARS.indexOf(row.year);
      assert.notEqual(index, -1);
      assert.equal(context.annualMinor[index], row.minor);
      assert.equal(context.annualModerate[index], row.moderate);
      assert.equal(context.annualMajor[index], row.major);
    }
    assert(annual.counts.some(row => !row.available && row.minor === null));
    assert(annual.counts.some(row => row.available && row.observedDays > 0 && row.partial));
    assert(annual.counts.some(row => row.available && row.minor === 0 && row.moderate === 0 && row.major === 0));
    const fixture = helpers.annualCounts([{ t: "2024-06-01T12:00:00Z", ft: 0 }], new Set([2024]), history.thresholdsNAVD88, 2026);
    assert.equal(fixture[0].minor, 0);
    assert.equal(fixture[1].minor, null);
    assert.equal(fixture[2].minor, null);
  });

  await test("seasonal history contains genuine USGS years from 2000, without official or Lewes records", () => {
    const seasonal = context.USGS_HISTORY_NAVD;
    assert(seasonal.length > 0);
    assert(seasonal.every(row => row.historyAgency === "USGS" && row.y >= 2000 && !row.officialCrestOverride && !row.officialCrestOnly));
    assert.equal(Math.min(...context.DOY_CACHE.years), 2000);
    const rawLocal = history.events.filter(row => row.historyAgency === "USGS" && !row.officialCrestOverride && !row.officialCrestOnly);
    assert.deepEqual(Array.from(context.DOY_CACHE.years), [...new Set(rawLocal.map(row => row.y))].sort((a, b) => a - b));
    const keys = new Set(seasonal.map(crestKey));
    const officialDates = new Set(history.events.filter(row => row.officialCrestOverride).map(row => row.localDate));
    for (const row of rawLocal.filter(row => officialDates.has(row.localDate))) assert(keys.has(crestKey(row)), `Official annual authority erased a measured seasonal crest ${crestKey(row)}`);
    const zeroYear = context.computeDOYStatsFromEvents([{ t: "2025-02-01T12:00:00Z", ft: 0, y: 2025, m: 2, d: 1 }]);
    assert.deepEqual(Array.from(zeroYear.years), [2025], "Zero-flood observed years must remain selectable");
    assert.equal(zeroYear.seriesByYear[0].cum[364], 0);
  });

  await test("historic date filters use local civil dates, including late-evening crests", () => {
    const filterContext = makeContext("2026-09-04T12:00:00Z");
    install(filterContext, ["applyFilter"]);
    filterContext.minElevEl = filterContext.maxElevEl = { value: "" };
    filterContext.fromDateEl = filterContext.toDateEl = { value: "2026-09-03" };
    filterContext.sortModeEl = { value: "desc" };
    filterContext.fromDisplayToNavd = value => value;
    filterContext.HISTORIC_CRESTS_NAVD = [
      { t: "2026-09-04T02:00:00Z", ft: 4 },
      { t: "2026-09-03T02:00:00Z", ft: 5 }
    ];
    let shown;
    filterContext.renderHist = rows => { shown = rows; };
    filterContext.applyFilter();
    assert.equal(shown.length, 1);
    assert.equal(shown[0].t, "2026-09-04T02:00:00Z");
  });

  await test("past forecasts start at 2026 and include the current year with mocked 2026, 2027, and 2030 clocks", () => {
    for (const year of [2026, 2027, 2030]) {
      const c = makeContext(`${year}-01-02T12:00:00Z`);
      const years = Array.from({ length: year - 1999 }, (_, index) => 2000 + index);
      c.DOY_CONTROL_YEARS = years;
      c.DOY_VIEW_MODE = "past";
      c.DOY_ANNUAL_FORECAST_ENABLED = true;
      const expected = Array.from({ length: year - 2025 }, (_, index) => 2026 + index);
      assert.deepEqual(Array.from(c.getDOYSelectableYears([...years, year + 1], year)), expected);
      c.setDOYRange(1919, 1919, "year");
      assert.equal(c.DOY_PAST_SELECTED_YEAR, 2026);
      c.setDOYRange(year + 100, year + 100, "year");
      assert.equal(c.DOY_PAST_SELECTED_YEAR, year);
      c.DOY_CONTROL_YEARS = years.filter(value => value !== year - 2);
      c.setDOYRange(year - 2, year - 2, "year");
      assert(c.DOY_PAST_SELECTED_YEAR >= 2026 && c.DOY_PAST_SELECTED_YEAR <= year);
      assert(c.DOY_CONTROL_YEARS.includes(c.DOY_PAST_SELECTED_YEAR), "Manual selection must snap to an available year");
      c.DOY_VIEW_MODE = "years";
      assert.deepEqual(Array.from(c.getDOYSelectableYears(years, year)), years, "Old observed years remain available in ordinary forecast mode");
      c.DOY_ANNUAL_FORECAST_ENABLED = false;
      assert.deepEqual(Array.from(c.getDOYSelectableYears(years, year)), years);
    }
  });

  await test("forecast defaults to current plus forecast; all comparison lines remain optional and preserve user choices", () => {
    const c = makeContext(annual.generatedAtUtc);
    c.DOY_CACHE = context.DOY_CACHE;
    c.HIGH_TIDES_NAVD = context.HIGH_TIDES_NAVD;
    c.USGS_HISTORY_NAVD = context.USGS_HISTORY_NAVD;
    c.doyYearColor = () => "#888";
    c.currentAnnualForecastInfo = year => ({ year, mean: 40, low: 25, high: 60 });
    c.pastAnnualForecastInfo = c.currentAnnualForecastInfo;
    c.seasonalHistoricForecastInfo = c.currentAnnualForecastInfo;
    c.buildDoySeasonalForecastPath = () => ({ low: Array(365).fill(25), mean: Array(365).fill(40), high: Array(365).fill(60) });
    install(c, ["renderDOYCumPanel", "firstLegendColor", "doyLegendItems"]);
    const now = c.getESTParts(new c.Date());
    const todayIdx = c.calIndex365(now.y, now.m, now.d);
    const byKind = kind => c.doyCumChart.data.datasets.find(row => row._kind === kind);
    const shownKinds = () => Array.from(c.doyCumChart.data.datasets).filter((_, index) => c.doyCumChart.isDatasetVisible(index)).map(row => row._kind).sort();
    const toggle = kind => {
      const chart = c.doyCumChart;
      const index = chart.data.datasets.findIndex(row => row._kind === kind);
      assert(index >= 0, `Missing comparison ${kind}`);
      chart.options.plugins.legend.onClick({}, { datasetIndex: index }, { chart });
    };
    for (const mode of ["years", "past"]) {
      c.DOY_VIEW_MODE = mode;
      c.DOY_ANNUAL_FORECAST_ENABLED = true;
      c.resetDOYForecastVisibility();
      c.renderDOYCumPanel();
      const forecastKind = mode === "past" ? "pastForecast" : "seasonalForecast";
      assert.deepEqual(shownKinds(), ["current", forecastKind].sort());
      const observed = byKind("current");
      assert.equal(observed._year, now.y);
      assert.equal(observed.borderColor, "rgba(239,68,68,1)");
      assert.deepEqual(plain(observed.data), plain(c.buildYTDSeriesFromEvents(c.USGS_HISTORY_NAVD)));
      assert(observed.data.slice(0, todayIdx + 1).every(Number.isFinite));
      assert(observed.data.slice(todayIdx + 1).every(value => value === null), "Current observations cannot extend into the future in either mode");
      const items = c.doyLegendItems(c.doyCumChart);
      assert(items.some(item => item.text === `${now.y} Observed` && !item.hidden));
      for(const label of ["Average", "Historic Range", "Forecast Range"]){
        assert(items.some(item => item.text === label && item.hidden), `Unchecked ${label} remains available`);
      }
      for(const kind of ["average", "range", "seasonalForecastRangeHigh"]){
        toggle(kind);
        c.renderDOYCumPanel();
        assert.equal(byKind(kind).hidden, false, `${kind} selection survives rerender`);
      }
      for(const [lowKind, highKind] of [["rangeFloor", "range"], ["seasonalForecastRangeLow", "seasonalForecastRangeHigh"]]){
        const rows = c.doyCumChart.data.datasets;
        const low = rows.findIndex(row => row._kind === lowKind);
        const high = rows.findIndex(row => row._kind === highKind);
        assert.equal(high, low + 1);
        assert.equal(rows[high].fill, "-1");
        assert.equal(rows[low].hidden, false);
        assert.equal(rows[high].hidden, false);
      }
      toggle("current"); toggle(forecastKind); c.renderDOYCumPanel();
      assert.equal(byKind("current").hidden, true);
      assert.equal(byKind(forecastKind).hidden, true);
      c.resetDOYForecastVisibility(); c.renderDOYCumPanel();
      assert.deepEqual(shownKinds(), ["current", forecastKind].sort(), "Next forecast activation resets manual selections");
    }
    c.DOY_PAST_SELECTED_YEAR = 2026;
    c.renderDOYCumPanel();
    assert.equal(byKind("pastForecast")._forecastYear, 2026);
    assert(byKind("current"), "Current year comparison remains present for a selected forecast year");
    c.DOY_VIEW_MODE = "years";
    c.DOY_ANNUAL_FORECAST_ENABLED = false;
    c.renderDOYCumPanel();
    const kinds = Array.from(c.doyCumChart.data.datasets, row => row._kind);
    for (const kind of ["range", "average", "year", "current"]) assert(kinds.includes(kind));
    assert(!kinds.some(kind => /forecast/i.test(kind)));
  });

  await test("PETSS parser does not turn no-data into zero; actual zero and tide-plus-surge fallback remain valid", () => {
    const csv = ["TIME,TWL,TIDE,SURGE", "202609040000,9999.000,9999.000,9999.000", "202609040100,,,", "202609040200,0,0,0", "202609040300,,1.25,0.5", "202609040400,2,,"].join("\n");
    const rows = petss.parseNomadsStationCsv(csv, "8535901");
    assert.deepEqual(rows.map(row => row.twl), [0, 1.75, 2]);
    assert.equal(rows[2].tide, null);
    assert.equal(rows[2].surge, null);
    assert.throws(() => petss.parseNomadsStationCsv("TIME,TWL,TIDE,SURGE\n202609040000,9999,9999,9999", "8535901"), /0 usable rows/);
    install(context, ["normalizePetssJsonToPoints"]);
    const invalid = [null, undefined, "", "  ", "ND", "NaN", 9999].map(value => ({ t: "2026-09-04T12:00:00Z", value, primary: value }));
    for (const shape of [invalid, { points: invalid }, { data: invalid }]) assert.equal(context.normalizePetssJsonToPoints(shape).length, 0, "Missing/invalid forecast values cannot become a zero-ft prediction");
    assert.equal(context.normalizePetssJsonToPoints([{ t: "2026-09-04T12:00:00Z", twl: 0 }])[0].ft, 0);
  });

  await test("PETSS cache, metadata, issued time and expiration agree; refreshed snapshot has 223 points", async () => {
    assert(Array.isArray(forecast));
    assert.equal(forecastMeta.stid, "8535901");
    assert.equal(forecastMeta.datum, "MLLW");
    assert.equal(forecastMeta.n_points, forecast.length);
    if (forecastMeta.run_dir === "petss.20260904" && forecastMeta.cycle === "t06z") assert.equal(forecast.length, 223);
    assert(forecast.length > 1);
    for (let index = 0; index < forecast.length; index++) {
      const row = forecast[index];
      assert(Number.isFinite(Date.parse(row.t)) && typeof row.twl === "number" && Number.isFinite(row.twl));
      assert(Math.abs(row.twl) < 100);
      if (index) assert(Date.parse(row.t) > Date.parse(forecast[index - 1].t));
    }
    assert.equal(Date.parse(forecastMeta.valid_through_utc), Date.parse(forecast.at(-1).t));
    assert(Date.parse(forecastMeta.model_time_utc) < Date.parse(forecastMeta.valid_through_utc));
    assert.match(forecastMeta.source_url, /^https:\/\/nomads\.ncep\.noaa\.gov\//);
    const c = makeContext(forecastMeta.model_time_utc);
    c.PETSS_JSON_CANDIDATES = ["offline-fixture"];
    c.fetchFirstOkJson = async () => ({ url: "offline-fixture", json: forecast });
    c.fetch = async () => ({ ok: true, json: async () => forecastMeta });
    install(c, ["normalizePetssJsonToPoints", "fetchPETSSForecast_MLLW"]);
    const result = await c.fetchPETSSForecast_MLLW();
    assert.equal(result.issuedTime, forecastMeta.model_time_utc);
    assert.equal(result.points.length, forecast.length);
    c.Date.now = () => Date.parse(forecastMeta.valid_through_utc) + 1000;
    await assert.rejects(c.fetchPETSSForecast_MLLW(), /expired/);
  });

  console.log(`PASS ${passed} dashboard regression groups (${root})`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
