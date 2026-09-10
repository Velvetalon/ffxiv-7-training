#!/usr/bin/env node
/**
 * Convert detailed verifier/benchmark artifacts into a bounded regression summary.
 *
 * node scripts/assets/summarize-regression.mjs --config=config/map-regression.json --reports=work/run.json --out=work/regression-summary.json
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).filter(value => value.startsWith('--')).map(value => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.length ? rest.join('=') : true];
}));
let selfTestDir = null;
if (args['self-test']) {
  selfTestDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff14-regression-summary-'));
  const ids = ['fail-a', 'fail-b', 'perf', 'duplicate', 'unknown', ...Array.from({ length: 17 }, (_, index) => `excess-${index + 1}`), 'not-run-a', 'not-run-b'];
  const environment = { browserVersion: 'fixture-browser', platform: 'fixture-os', arch: 'fixture-arch', deviceId: 'fixture-device', viewport: { width: 1440, height: 900 }, cachePolicy: 'fresh', networkProfile: 'fixture-network', concurrency: 1 };
  const zone = (id, metrics, status = 'pass') => ({ id, status, metrics, failureReasons: metrics.loadSuccess === false ? ['fixture failure'] : [], diagnostics: { pageErrors: [], consoleErrors: [], failedRequests: [] }, full: { glError: 0, textureAudit: { previewVariants: 0, dimensionsInvalid: 0 } } });
  const passMetrics = (first = 1000, tti = 1200) => ({ loadSuccess: true, firstVisibleRenderMs: first, ttiMs: tti, missingAssets: 0, jsErrors: 0, gpuErrors: 0, memoryPeakSampled: { decodedBytes: 100, sampled: true }, keyCounts: {} });
  const baseline = { selection: ids, measurementEnvironment: environment, artifactFingerprint: { build: 'baseline' }, zones: [zone('perf', passMetrics(1000, 1000)), zone('duplicate', passMetrics(1000, 1000)), zone('unknown', passMetrics(1000, 1000))] };
  const current = { selection: ids, measurementEnvironment: environment, artifactFingerprint: { build: 'current-different-artifact' }, zones: [
    zone('fail-a', { ...passMetrics(), loadSuccess: false, missingAssets: 1 }, 'fail'), zone('fail-b', { ...passMetrics(), loadSuccess: false, jsErrors: 1 }, 'fail'),
    zone('perf', passMetrics(1740, 1740)), ...Array.from({ length: 17 }, (_, index) => zone(`excess-${index + 1}`, { ...passMetrics(), loadSuccess: false }, 'fail')),
  ] };
  const full = { selection: ids, measurementEnvironment: environment, artifactFingerprint: { build: 'current-different-artifact' }, zones: [zone('duplicate', passMetrics(1740, 1740))] };
  const unknown = { selection: ids, zones: [zone('unknown', {}, 'unknown')] };
  const config = { schemaVersion: 1, smokeScenes: ids.map(id => ({ id, reason: 'fixture' })), baseline: { required: false, path: path.join(selfTestDir, 'baseline.json') }, thresholds: { coldFirstVisibleMs: 10000, coldTTIMs: 30000, warmTTIMs: 5000, relativeRegression: 0.2, minimumDeltaMs: 250, memoryAbsoluteBytes: 999999, memoryRelativeRegression: 0.2, memoryMinimumDeltaBytes: 1 } };
  await Promise.all([
    fs.writeFile(path.join(selfTestDir, 'baseline.json'), JSON.stringify(baseline)), fs.writeFile(path.join(selfTestDir, 'current.json'), JSON.stringify(current)),
    fs.writeFile(path.join(selfTestDir, 'full.json'), JSON.stringify(full)), fs.writeFile(path.join(selfTestDir, 'unknown.json'), JSON.stringify(unknown)),
    fs.writeFile(path.join(selfTestDir, 'config.json'), JSON.stringify(config)),
  ]);
  args.config = path.join(selfTestDir, 'config.json');
  args.reports = [path.join(selfTestDir, 'current.json'), path.join(selfTestDir, 'full.json'), path.join(selfTestDir, 'unknown.json')].join(',');
  args.out = path.join(selfTestDir, 'summary.json');
}
if (!args.config || !args.reports || !args.out) throw new Error('Required: --config=FILE --reports=FILE[,FILE] --out=FILE');
const configPath = path.resolve(args.config);
const reportPaths = String(args.reports).split(',').map(value => path.resolve(value.trim())).filter(Boolean);
const outPath = path.resolve(args.out);
const topLimit = Math.min(20, Math.max(1, Number(args['top-limit'] || 20)));
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const thresholds = config.thresholds || {};
const number = value => Number.isFinite(value) ? Number(value) : null;
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const eventMs = (profiler, name) => number(profiler?.events?.find(event => event.name === name)?.elapsedMs);
const configuredSmokeIds = new Set((config.smokeScenes || []).map(item => typeof item === 'string' ? item : item.id).filter(Boolean));

function verifierRecords(report, source) {
  const zones = (report.zones || []).map(zone => {
    const metrics = zone.metrics || {};
    const full = zone.full || {};
    const pre = zone.preFull || {};
    const profiler = full.profiler || pre.profiler;
    const memory = metrics.memoryPeakSampled || null;
    return {
      id: zone.id, label: zone.id, source, kind: 'runtime', status: zone.status || 'unknown',
      loadSuccess: metrics.loadSuccess ?? ((zone.status === 'pass' || zone.status === 'resumed-pass') ? true : null),
      firstVisibleRenderMs: number(metrics.firstVisibleRenderMs ?? eventMs(profiler, 'first-visible-render')),
      ttiMs: number(metrics.ttiMs ?? eventMs(profiler, 'interactive')),
      missingAssets: number(metrics.missingAssets ?? zone.diagnostics?.failedRequests?.length),
      jsErrors: number(metrics.jsErrors ?? ((zone.diagnostics?.pageErrors?.length || 0) + (zone.diagnostics?.consoleErrors?.length || 0))),
      gpuErrors: number(metrics.gpuErrors ?? (full.glError === undefined ? null : Number(full.glError !== 0))),
      memoryPeakSampled: memory?.decodedBytes === undefined ? null : { ...memory, sampled: true },
      keyCounts: metrics.keyCounts || (full.completed === undefined ? null : { expectedModels: zone.expectedModels, completedModels: full.completed, finalPreviewVariants: full.textureAudit?.previewVariants, invalidTextureDimensions: full.textureAudit?.dimensionsInvalid }),
      failureReasons: zone.failureReasons || (zone.error ? [zone.error] : []), screenshotDiff: zone.screenshotDiff ?? null,
      environment: report.measurementEnvironment || null,
      artifactFingerprint: report.artifactFingerprint || null,
      measurementClock: 'profiler action-relative clock',
    };
  });
  const transitions = (report.transitions || []).map(transition => ({
    id: transition.label || `${transition.sourceScene || 'unknown'}:${transition.connection || 'unknown'}->${transition.target || 'unknown'}`,
    label: transition.label || 'representative transition', source, kind: 'transition', status: transition.status || 'unknown',
    loadSuccess: transition.status === 'pass' ? true : transition.status === 'fail' ? false : null,
    firstVisibleRenderMs: null, ttiMs: null,
    missingAssets: number(transition.diagnostics?.failedRequests?.length), jsErrors: number((transition.diagnostics?.pageErrors?.length || 0) + (transition.diagnostics?.consoleErrors?.length || 0)), gpuErrors: null,
    memoryPeakSampled: null, keyCounts: null, failureReasons: transition.status === 'fail' ? [transition.error || 'representative transition failed'] : [], screenshotDiff: null,
    environment: report.measurementEnvironment || null, artifactFingerprint: report.artifactFingerprint || null, measurementClock: 'profiler action-relative clock', transition: true,
  }));
  return [...zones, ...transitions];
}

function benchmarkRecords(report, source) {
  return (report.runs || []).map(run => {
    const warm = /^warm-/.test(run.label || '');
    return {
      id: run.target || run.label, label: run.label, source, kind: warm ? 'warm' : 'cold', status: run.status || 'complete',
      loadSuccess: run.status === 'incomplete' ? false : run.world?.streamError ? false : true,
      firstVisibleRenderMs: number(run.visibleFirstRenderMs ?? run.firstRenderMs), ttiMs: number(run.interactiveMs),
      missingAssets: number(run.diagnostics?.failedRequests?.length), jsErrors: number(run.diagnostics?.pageErrors?.length), gpuErrors: number(run.world?.glError === undefined ? null : Number(run.world.glError !== 0)),
      memoryPeakSampled: null, keyCounts: run.materialAudit ? { finalPreviewVariants: run.materialAudit.previewVariants, invalidTextureDimensions: run.materialAudit.dimensionsInvalid } : null,
      failureReasons: run.status === 'incomplete' ? [run.error || 'incomplete'] : [], screenshotDiff: run.screenshotDiff ?? null,
      environment: report.measurementEnvironment || report.method?.environment || null,
      artifactFingerprint: report.artifactFingerprint || null,
      measurementClock: report.method?.phaseClock || 'navigation/action-relative clock',
    };
  });
}

function normalize(report, source) {
  if (Array.isArray(report.zones)) return verifierRecords(report, source);
  if (Array.isArray(report.runs)) return benchmarkRecords(report, source);
  return [];
}

function environmentComparable(current, baseline) {
  if (!current?.environment || !baseline?.environment) return false;
  const a = current.environment, b = baseline.environment;
  const required = ['browserVersion', 'platform', 'arch', 'deviceId', 'viewport', 'cachePolicy', 'networkProfile', 'concurrency'];
  if (required.some(key => a[key] === undefined || b[key] === undefined) || current.measurementClock !== baseline.measurementClock) return false;
  return required.every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

const reports = await Promise.all(reportPaths.map(async file => ({ file, data: await read(file) })));
const rawRecords = reports.flatMap(item => normalize(item.data, item.file));
const deduped = new Map();
for (const record of rawRecords) deduped.set(`${record.kind}:${record.id}`, record);
const records = [...deduped.values()];
const baselineFiles = [...(config.baseline?.reports || []), config.baseline?.path, ...(args.baseline ? String(args.baseline).split(',') : [])].filter(Boolean).map(file => path.resolve(file.trim()));
const baselineAvailable = [];
for (const file of baselineFiles) {
  try { baselineAvailable.push(...normalize(await read(file), file)); } catch {}
}
const baselineByKey = new Map(baselineAvailable.map(record => [`${record.kind}:${record.id}`, record]));
const relative = Number(thresholds.relativeRegression ?? 0.2);
const minDeltaMs = Number(thresholds.minimumDeltaMs ?? 250);
const memoryRelative = Number(thresholds.memoryRelativeRegression ?? relative);
const memoryMin = Number(thresholds.memoryMinimumDeltaBytes ?? 67108864);

function overRelative(current, baseline, ratio, minimum) {
  return Number.isFinite(current) && Number.isFinite(baseline) && current > baseline * (1 + ratio) && current - baseline >= minimum;
}
function analyze(record) {
  const baseline = baselineByKey.get(`${record.kind}:${record.id}`) || null;
  const absolute = [];
  if (record.kind === 'transition') {
    // Transition failures are functional gate failures; they do not carry performance budgets.
  } else if (record.kind === 'warm') {
    if (record.ttiMs !== null && record.ttiMs > Number(thresholds.warmTTIMs ?? 5000)) absolute.push('warm TTI budget');
  } else {
    if (record.firstVisibleRenderMs !== null && record.firstVisibleRenderMs > Number(thresholds.coldFirstVisibleMs ?? 10000)) absolute.push('first visible render budget');
    if (record.ttiMs !== null && record.ttiMs > Number(thresholds.coldTTIMs ?? 30000)) absolute.push('TTI budget');
  }
  const unmeasured = [];
  if (record.loadSuccess === null) unmeasured.push('load success');
  if (record.firstVisibleRenderMs === null) unmeasured.push('first visible render');
  if (record.ttiMs === null) unmeasured.push('TTI');
  if (record.missingAssets === null) unmeasured.push('missing assets');
  if (record.jsErrors === null) unmeasured.push('JS errors');
  if (record.gpuErrors === null) unmeasured.push('GPU errors');
  if (!record.memoryPeakSampled?.sampled) unmeasured.push('sampled memory peak');
  const relativeReasons = [];
  const comparable = environmentComparable(record, baseline);
  if (baseline && comparable) {
    if (overRelative(record.firstVisibleRenderMs, baseline.firstVisibleRenderMs, relative, minDeltaMs)) relativeReasons.push('first visible render relative regression');
    if (overRelative(record.ttiMs, baseline.ttiMs, relative, minDeltaMs)) relativeReasons.push('TTI relative regression');
    if (overRelative(record.memoryPeakSampled?.decodedBytes, baseline.memoryPeakSampled?.decodedBytes, memoryRelative, memoryMin)) relativeReasons.push('sampled memory relative regression');
  } else if (baseline) unmeasured.push('comparable baseline environment');
  else unmeasured.push('historical baseline');
  if (record.memoryPeakSampled?.decodedBytes !== null && record.memoryPeakSampled?.decodedBytes > Number(thresholds.memoryAbsoluteBytes ?? Infinity)) absolute.push('sampled memory budget');
  const functionalFailure = record.loadSuccess === false || (record.missingAssets || 0) > 0 || (record.jsErrors || 0) > 0 || (record.gpuErrors || 0) > 0 || record.failureReasons.length > 0;
  const performanceRegression = absolute.length > 0 || relativeReasons.length > 0;
  const outlier = performanceRegression || record.screenshotDiff?.abnormal === true;
  return { ...record, baseline: baseline ? { source: baseline.source, comparable } : null, functionalFailure, performanceRegression, outlier, absolute, relativeReasons, unmeasured };
}

const analyzed = records.map(analyze);
const selectionPath = args.selection ? path.resolve(args.selection) : null;
const selection = selectionPath ? JSON.parse(await fs.readFile(selectionPath, 'utf8')) : null;
const reportedSelection = [...new Set(reports.flatMap(item => Array.isArray(item.data.selection) ? item.data.selection : []))];
const expectedIds = new Set(selection?.selected || (reportedSelection.length ? reportedSelection : configuredSmokeIds));
const byId = new Set(analyzed.map(record => record.id));
const notRun = [...expectedIds].filter(id => !byId.has(id));
const transitionRecords = analyzed.filter(record => record.kind === 'transition');
const expectedTransitions = reports.some(item => item.data.summary?.releaseReady !== undefined || item.data.complete !== undefined) ? 4 : 0;
const notRunTransitions = Math.max(0, expectedTransitions - transitionRecords.length);
const abnormal = analyzed.filter(record => record.functionalFailure || record.performanceRegression || record.outlier);
const detail = abnormal.slice(0, topLimit).map(record => ({ id: record.id, label: record.label, source: record.source, functionalFailure: record.functionalFailure, performanceRegression: record.performanceRegression, outlier: record.outlier, reasons: [...record.failureReasons, ...record.absolute, ...record.relativeReasons] }));
const unmeasuredByField = Object.fromEntries([...new Set(analyzed.flatMap(record => record.unmeasured))].map(field => [field, analyzed.filter(record => record.unmeasured.includes(field)).length]));
const summary = {
  generatedAt: new Date().toISOString(), config: configPath, reports: reportPaths,
  counts: {
    total: analyzed.filter(record => record.kind !== 'transition').length,
    pass: analyzed.filter(record => record.kind !== 'transition' && record.loadSuccess === true && !record.functionalFailure).length,
    failed: analyzed.filter(record => record.functionalFailure).length,
    functionalUnknown: analyzed.filter(record => record.kind !== 'transition' && record.loadSuccess === null && !record.functionalFailure).length,
    performanceRegression: analyzed.filter(record => record.performanceRegression).length,
    outliers: analyzed.filter(record => record.outlier).length,
    unmeasured: analyzed.filter(record => record.unmeasured.length > 0).length,
    notRun: notRun.length,
    transitionPassed: transitionRecords.filter(record => record.loadSuccess === true).length,
    transitionFailed: transitionRecords.filter(record => record.functionalFailure).length,
    transitionNotRun: notRunTransitions,
  },
  accounting: 'Total/pass count map records only. Failed includes map and representative-transition functional failures; transition counts are separate. Performance regression, outlier, and unmeasured counts overlap and must not be summed.',
  baseline: { required: Boolean(config.baseline?.required), configuredReports: baselineFiles, usableRecords: baselineAvailable.length, comparableRecords: analyzed.filter(record => record.baseline?.comparable).length },
  selection: { expected: [...expectedIds], source: selectionPath || (reportedSelection ? 'report.selection' : 'config.smokeScenes') },
  unmeasuredByField, notRun, details: detail, truncatedAbnormalDetails: Math.max(0, abnormal.length - detail.length),
};
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
const mdPath = outPath.replace(/\.json$/i, '.md');
const lines = [
  '# Regression summary', '',
  `Total: ${summary.counts.total}`, `Pass: ${summary.counts.pass}`, `Failed: ${summary.counts.failed}`, `Performance Regression: ${summary.counts.performanceRegression}`, `Outliers: ${summary.counts.outliers}`, `Unmeasured: ${summary.counts.unmeasured}`, `Not Run: ${summary.counts.notRun}`, '',
  summary.accounting, '',
  '## Exceptions', '',
  ...(detail.length ? detail.map(item => `- ${item.id}: ${item.reasons.join('; ') || 'classification requires review'}`) : ['- None.']),
  ...(summary.truncatedAbnormalDetails ? [`- ${summary.truncatedAbnormalDetails} additional exceptions retained only in raw reports.`] : []),
  ...(summary.counts.unmeasured ? ['', `Unmeasured fields: ${Object.entries(unmeasuredByField).map(([field, count]) => `${field} (${count})`).join(', ')}.`] : []),
  ...(notRun.length ? ['', '## Not run', '', ...notRun.map(id => `- ${id}`)] : []),
  ...(summary.counts.transitionNotRun ? ['', `Representative transitions not run: ${summary.counts.transitionNotRun}.`] : []), '',
];
await fs.writeFile(mdPath, lines.join('\n'));
console.log(JSON.stringify({ counts: summary.counts, exceptions: detail.length, truncated: summary.truncatedAbnormalDetails, summary: outPath, markdown: mdPath }));
if (summary.counts.failed || summary.counts.functionalUnknown || summary.counts.performanceRegression || summary.counts.notRun || (config.baseline?.required && summary.baseline.usableRecords === 0)) process.exitCode = 1;
if (selfTestDir) {
  const assert = (condition, message) => { if (!condition) throw new Error(`self-test: ${message}`); };
  assert(summary.counts.total === 22 && summary.counts.notRun === 2, 'partial selection must report two not-run maps');
  assert(summary.counts.failed === 19, 'functional failures must remain distinct from performance regressions');
  assert(summary.counts.performanceRegression === 2 && summary.counts.outliers === 2, 'same-environment different-artifact performance regressions must compare');
  assert(summary.counts.functionalUnknown === 1 && summary.counts.pass === 2, 'missing functional metrics must not count as pass');
  assert(summary.truncatedAbnormalDetails === 1 && summary.details.length === 20, 'exception details must be bounded and report truncation');
  assert(summary.baseline.comparableRecords === 2, 'same environment must compare despite different artifact identity');
  assert(summary.unmeasuredByField['comparable baseline environment'] >= 1, 'empty environment must be not comparable');
  console.log(JSON.stringify({ ok: true, fixtureDir: selfTestDir }));
}
