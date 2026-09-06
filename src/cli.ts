#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { cac } from 'cac';
import pc from 'picocolors';
import { auditSnapshot } from './audit.js';
import { diffSnapshots } from './diff.js';
import { detectPlatform, withGuidance } from './rules/guidance.js';
import {
  aggregate,
  applyConfig,
  formatAuditHtml,
  formatAuditMarkdown,
  formatAuditPretty,
  formatGithub,
  formatJson,
  formatMarkdown,
  formatPretty,
  shouldFail,
  summarize,
} from './report.js';
import { sameSurface, snapshotFromDir, snapshotFromOrigin } from './snapshot.js';
import type { Config, Severity, Snapshot } from './types.js';

/** Injected from package.json at build time; see tsup.config.ts. */
declare const __VERSION__: string;

const DEFAULT_LOCKFILE = 'pagetrace.lock.json';
const DEFAULT_CONFIG = 'pagetrace.config.json';

/** Findings at or above --fail-on. The site has a problem. */
const EXIT_FINDINGS = 1;
/** The run itself failed: bad flags, unreachable origin, unreadable build. */
const EXIT_FAILURE = 2;

async function writeLockfile(path: string, next: Snapshot): Promise<boolean> {
  const previous = await readFile(path, 'utf8')
    .then((text) => JSON.parse(text) as Snapshot)
    .catch(() => null);
  if (previous && sameSurface(previous, next)) return false;
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return true;
}

interface SourceFlags {
  dir?: string;
  url?: string;
  limit?: number;
  concurrency?: number;
}

const SEVERITIES: Severity[] = ['error', 'warn', 'info'];

/**
 * Validated up front: an unrecognised value used to leave the exit gate
 * permanently off, so `check --fail-on warning` printed errors and went green.
 */
function parseFailOn(value: unknown, allowNever: boolean): Severity | 'never' {
  const expected = [...SEVERITIES, ...(allowNever ? ['never'] : [])].join(' | ');
  if (typeof value !== 'string') throw new Error(`--fail-on needs a value. Expected ${expected}.`);
  if (allowNever && value === 'never') return 'never';
  if ((SEVERITIES as string[]).includes(value)) return value as Severity;
  throw new Error(`Invalid --fail-on "${value}". Expected ${expected}.`);
}

async function loadConfig(path = DEFAULT_CONFIG): Promise<Config> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Config;
  } catch {
    return {};
  }
}

async function build(flags: SourceFlags, config: Config): Promise<Snapshot> {
  if (flags.dir) return snapshotFromDir(flags.dir, config);
  if (flags.url)
    return snapshotFromOrigin(flags.url, {
      ...config,
      limit: flags.limit,
      concurrency: flags.concurrency,
    });
  throw new Error('Provide a source: --dir <build directory> or --url <origin>.');
}

function render(findings: ReturnType<typeof applyConfig>, format: string): string {
  switch (format) {
    case 'json':
      return formatJson(findings);
    case 'markdown':
      return formatMarkdown(findings);
    case 'github':
      return formatGithub(findings);
    default:
      return formatPretty(findings);
  }
}

const cli = cac('pagetrace');

cli
  .command('snapshot', 'Record the current SEO/AEO surface to a lockfile')
  .option('--dir <dir>', 'Directory of built HTML')
  .option('--url <origin>', 'Live origin to crawl')
  .option('--limit <n>', 'Max pages to crawl', { default: 200 })
  .option('--concurrency <n>', 'Parallel requests', { default: 5 })
  .option('--out <file>', 'Lockfile path', { default: DEFAULT_LOCKFILE })
  .option('--config <file>', 'Config file', { default: DEFAULT_CONFIG })
  .action(async (flags) => {
    const config = await loadConfig(flags.config);
    const snapshot = await build(flags, config);
    const written = await writeLockfile(flags.out, snapshot);
    const count = Object.keys(snapshot.pages).length;
    console.log(
      written
        ? pc.green(`Wrote ${flags.out} — ${count} page${count === 1 ? '' : 's'}.`)
        : pc.dim(`${flags.out} is already up to date — ${count} page${count === 1 ? '' : 's'}.`),
    );
  });

cli
  .command('check', 'Compare the current surface against the lockfile')
  .option('--dir <dir>', 'Directory of built HTML')
  .option('--url <origin>', 'Live origin to crawl')
  .option('--limit <n>', 'Max pages to crawl', { default: 200 })
  .option('--concurrency <n>', 'Parallel requests', { default: 5 })
  .option('--lockfile <file>', 'Lockfile path', { default: DEFAULT_LOCKFILE })
  .option('--config <file>', 'Config file', { default: DEFAULT_CONFIG })
  .option('--format <format>', 'pretty | json | markdown | github', { default: 'pretty' })
  .option('--fail-on <severity>', 'error | warn | info', { default: 'error' })
  .option('--audit', 'Also run absolute rules, not just the diff', { default: true })
  .option('--update', 'Write the new state to the lockfile after reporting')
  .action(async (flags) => {
    const failOn = parseFailOn(flags.failOn, false) as Severity;
    const config = await loadConfig(flags.config);
    const next = await build(flags, config);

    let previous: Snapshot | null = null;
    try {
      previous = JSON.parse(await readFile(flags.lockfile, 'utf8')) as Snapshot;
    } catch {
      previous = null;
    }

    if (!previous) {
      console.error(
        pc.yellow(`No lockfile at ${flags.lockfile}. Run \`pagetrace snapshot\` first to set a baseline.`),
      );
    }

    const raw = [
      ...(previous ? diffSnapshots(previous, next) : []),
      ...(flags.audit ? auditSnapshot(next, config) : []),
    ];
    const findings = applyConfig(raw, config);

    console.log(render(findings, flags.format));

    if (flags.update) {
      const written = await writeLockfile(flags.lockfile, next);
      console.error(
        pc.dim(written ? `Updated ${flags.lockfile}.` : `${flags.lockfile} is already up to date.`),
      );
    }

    const summary = summarize(findings);
    if (previous && shouldFail(findings, failOn)) {
      console.error(
        pc.red(`\nFailing: ${summary.error} error, ${summary.warn} warning (--fail-on ${failOn}).`),
      );
      process.exitCode = EXIT_FINDINGS;
    }
  });

cli
  .command('audit', 'Audit a site as it stands, with explanations and fixes')
  .option('--url <origin>', 'Live origin to crawl')
  .option('--dir <dir>', 'Directory of built HTML')
  .option('--limit <n>', 'Max pages to crawl', { default: 200 })
  .option('--concurrency <n>', 'Parallel requests', { default: 5 })
  .option('--config <file>', 'Config file', { default: DEFAULT_CONFIG })
  .option('--format <format>', 'pretty | json | markdown | html', { default: 'pretty' })
  .option('--out <file>', 'Write the report to a file instead of stdout')
  .option('--fail-on <severity>', 'error | warn | info | never', { default: 'never' })
  .action(async (flags) => {
    const failOn = parseFailOn(flags.failOn, true);
    const config = await loadConfig(flags.config);
    const snapshot = await build(flags, config);
    const pages = Object.values(snapshot.pages);

    if (pages.length === 0) {
      console.error(
        pc.yellow(
          'No pages found. Check that the sitemap is reachable, or pass --dir with pre-rendered HTML.',
        ),
      );
      process.exitCode = EXIT_FAILURE;
      return;
    }

    const platform = detectPlatform(
      pages.map((p) => p.generator),
      pages.flatMap((p) => Object.values(p.og)),
    );

    const findings = applyConfig(auditSnapshot(snapshot, config), config).map((f) =>
      withGuidance(f, platform),
    );
    const groups = aggregate(findings);
    const meta = {
      target: flags.url ?? flags.dir ?? 'site',
      platform,
      pageCount: pages.length,
      generatedAt: new Date().toISOString().slice(0, 10),
    };

    const output =
      flags.format === 'json'
        ? JSON.stringify({ schemaVersion: 1, meta, summary: summarize(findings), groups }, null, 2)
        : flags.format === 'markdown'
          ? formatAuditMarkdown(groups, meta)
          : flags.format === 'html'
            ? formatAuditHtml(groups, meta)
            : formatAuditPretty(groups, meta);

    if (flags.out) {
      await writeFile(flags.out, `${output}\n`, 'utf8');
      console.log(pc.green(`Wrote ${flags.out} — ${groups.length} issue types across ${pages.length} pages.`));
    } else {
      console.log(output);
    }

    if (failOn !== 'never' && shouldFail(findings, failOn)) {
      process.exitCode = EXIT_FINDINGS;
    }
  });

cli.help();
cli.version(__VERSION__);

async function main() {
  try {
    cli.parse(process.argv, { run: false });
    await cli.runMatchedCommand();
  } catch (error) {
    console.error(pc.red((error as Error).message));
    process.exitCode = EXIT_FAILURE;
  }
}

void main();
