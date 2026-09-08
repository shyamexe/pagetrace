#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
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
  formatSarif,
  shouldFail,
  summarize,
} from './report.js';
import {
  sameSurface,
  snapshotFromDir,
  snapshotFromGitRef,
  snapshotFromOrigin,
  snapshotFromPage,
} from './snapshot.js';
import type { Config, Severity, Snapshot } from './types.js';
import { isNewer, latestVersion } from './update.js';

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
  ignoreRobots?: boolean;
  external?: boolean;
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
  const checkExternal = flags.external ?? config.checkExternal;
  if (flags.dir) return snapshotFromDir(flags.dir, { ...config, checkExternal });
  if (flags.url)
    return snapshotFromOrigin(flags.url, {
      ...config,
      limit: flags.limit,
      concurrency: flags.concurrency,
      ignoreRobots: flags.ignoreRobots ?? config.ignoreRobots,
      checkExternal,
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
    case 'sarif':
      return formatSarif(findings);
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
  .option('--ignore-robots', 'Crawl paths that robots.txt disallows')
  .option('--external', 'Also check links that leave the site')
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
  .option('--ignore-robots', 'Crawl paths that robots.txt disallows')
  .option('--external', 'Also check links that leave the site')
  .option('--lockfile <file>', 'Lockfile path', { default: DEFAULT_LOCKFILE })
  .option('--config <file>', 'Config file', { default: DEFAULT_CONFIG })
  .option('--format <format>', 'pretty | json | markdown | github | sarif', { default: 'pretty' })
  .option('--fail-on <severity>', 'error | warn | info', { default: 'error' })
  .option('--audit', 'Also run absolute rules, not just the diff', { default: true })
  .option('--update', 'Write the new state to the lockfile after reporting')
  .option('--baseline-branch <ref>', 'Read the baseline lockfile from a git ref instead of disk')
  .action(async (flags) => {
    const failOn = parseFailOn(flags.failOn, false) as Severity;
    const config = await loadConfig(flags.config);
    const next = await build(flags, config);

    // A pull request should be able to diff against main's baseline without
    // carrying a lockfile of its own, which is what makes this usable on a repo
    // that does not want lockfile churn in every feature branch.
    const previous = flags.baselineBranch
      ? await snapshotFromGitRef(flags.baselineBranch, flags.lockfile)
      : await readFile(flags.lockfile, 'utf8')
          .then((text) => JSON.parse(text) as Snapshot)
          .catch(() => null);

    if (!previous) {
      const where = flags.baselineBranch
        ? `No ${flags.lockfile} at ${flags.baselineBranch}.`
        : `No lockfile at ${flags.lockfile}.`;
      console.error(pc.yellow(`${where} Run \`pagetrace snapshot\` first to set a baseline.`));
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
  .option('--ignore-robots', 'Crawl paths that robots.txt disallows')
  .option('--external', 'Also check links that leave the site')
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
            : formatAuditPretty(groups, meta, process.stdout.columns);

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

cli
  .command('page <url>', 'Check one page: every link on it, and its own surface')
  // On by default here, unlike a crawl: one page's links are a bounded cost,
  // and "are this page's links dead" is the question being asked.
  .option('--external', 'Check links that leave the site', { default: true })
  .option('--concurrency <n>', 'Parallel requests', { default: 5 })
  .option('--config <file>', 'Config file', { default: DEFAULT_CONFIG })
  .option('--format <format>', 'pretty | json | markdown', { default: 'pretty' })
  .option('--out <file>', 'Write the report to a file instead of stdout')
  .option('--fail-on <severity>', 'error | warn | info | never', { default: 'error' })
  .action(async (url: string, flags) => {
    const failOn = parseFailOn(flags.failOn, true);
    const config = await loadConfig(flags.config);
    const snapshot = await snapshotFromPage(url, {
      ...config,
      concurrency: flags.concurrency,
      checkExternal: flags.external,
    });

    const [page] = Object.values(snapshot.pages);
    const platform = detectPlatform([page.generator], Object.values(page.og));
    // Page-level findings only. A single-page check never fetches robots.txt or
    // llms.txt, so reporting them as missing would be claiming absence from a
    // look that was never taken. `audit` is the command that asks about a site.
    const findings = applyConfig(auditSnapshot(snapshot, config), config)
      .filter((f) => f.route !== null)
      .map((f) => withGuidance(f, platform));

    if (findings.length === 0 && !flags.out) {
      const checked = (page.brokenLinks?.length ?? 0) + (page.deadExternal?.length ?? 0);
      console.log(pc.green(`${url} looks sound — no findings, no dead links.`));
      if (checked > 0) console.log(pc.dim('(unreachable links were treated as unknown, not dead)'));
      return;
    }

    const groups = aggregate(findings);
    const meta = {
      target: url,
      platform,
      pageCount: 1,
      generatedAt: new Date().toISOString().slice(0, 10),
    };
    const output =
      flags.format === 'json'
        ? JSON.stringify({ schemaVersion: 1, meta, summary: summarize(findings), groups }, null, 2)
        : flags.format === 'markdown'
          ? formatAuditMarkdown(groups, meta)
          : formatAuditPretty(groups, meta, process.stdout.columns);

    if (flags.out) {
      await writeFile(flags.out, `${output}\n`, 'utf8');
      console.log(pc.green(`Wrote ${flags.out}.`));
    } else {
      console.log(output);
    }

    if (failOn !== 'never' && shouldFail(findings, failOn)) {
      process.exitCode = EXIT_FINDINGS;
    }
  });

cli
  .command('links', 'Find internal links that point at no page')
  .option('--url <origin>', 'Live origin to crawl')
  .option('--dir <dir>', 'Directory of built HTML')
  .option('--limit <n>', 'Max pages to crawl', { default: 200 })
  .option('--concurrency <n>', 'Parallel requests', { default: 5 })
  .option('--ignore-robots', 'Crawl paths that robots.txt disallows')
  .option('--external', 'Also check links that leave the site')
  .option('--config <file>', 'Config file', { default: DEFAULT_CONFIG })
  .option('--format <format>', 'pretty | json | markdown', { default: 'pretty' })
  .option('--out <file>', 'Write the report to a file instead of stdout')
  .option('--fail-on <severity>', 'error | warn | info | never', { default: 'error' })
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

    // Runs every rule and keeps the link ones. The rules are pure functions
    // over a snapshot that is already in memory, so the waste is nothing and
    // this cannot report something different from what `audit` reports.
    const platform = detectPlatform(
      pages.map((p) => p.generator),
      pages.flatMap((p) => Object.values(p.og)),
    );
    const findings = applyConfig(auditSnapshot(snapshot, config), config)
      .filter((f) => f.code.startsWith('link.'))
      .map((f) => withGuidance(f, platform));

    const target = flags.url ?? flags.dir ?? 'site';
    if (findings.length === 0 && !flags.out) {
      console.log(
        pc.green(
          `No broken links found — ${pages.length} page${pages.length === 1 ? '' : 's'} checked.`,
        ),
      );
      return;
    }

    const groups = aggregate(findings);
    const meta = {
      target,
      platform,
      pageCount: pages.length,
      generatedAt: new Date().toISOString().slice(0, 10),
    };
    const output =
      flags.format === 'json'
        ? JSON.stringify({ schemaVersion: 1, meta, summary: summarize(findings), groups }, null, 2)
        : flags.format === 'markdown'
          ? formatAuditMarkdown(groups, meta)
          : formatAuditPretty(groups, meta, process.stdout.columns);

    if (flags.out) {
      await writeFile(flags.out, `${output}\n`, 'utf8');
      console.log(pc.green(`Wrote ${flags.out} — ${groups.length} broken link${groups.length === 1 ? '' : 's'}.`));
    } else {
      console.log(output);
    }

    if (failOn !== 'never' && shouldFail(findings, failOn)) {
      process.exitCode = EXIT_FINDINGS;
    }
  });

cli
  .command('init', 'Write a config file and take the first snapshot')
  .option('--dir <dir>', 'Directory of built HTML')
  .option('--url <origin>', 'Live origin to crawl')
  .option('--limit <n>', 'Max pages to crawl', { default: 200 })
  .option('--concurrency <n>', 'Parallel requests', { default: 5 })
  .option('--ignore-robots', 'Crawl paths that robots.txt disallows')
  .option('--external', 'Also check links that leave the site')
  .option('--out <file>', 'Lockfile path', { default: DEFAULT_LOCKFILE })
  .option('--config <file>', 'Config file', { default: DEFAULT_CONFIG })
  .action(async (flags) => {
    // Never clobber a config that already exists — it is hand-edited, and the
    // snapshot below is the part worth re-running anyway.
    const existing = await readFile(flags.config, 'utf8').catch(() => null);
    if (existing === null) {
      const config: Config = flags.url ? { siteUrl: new URL(flags.url).origin } : {};
      await writeFile(flags.config, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      console.log(pc.green(`Wrote ${flags.config}.`));
    } else {
      console.log(pc.dim(`${flags.config} already exists — leaving it alone.`));
    }

    const snapshot = await build(flags, await loadConfig(flags.config));
    const count = Object.keys(snapshot.pages).length;
    await writeLockfile(flags.out, snapshot);
    console.log(pc.green(`Wrote ${flags.out} — ${count} page${count === 1 ? '' : 's'}.`));
    console.log(
      pc.dim(
        `\nCommit both files, then run \`pagetrace check ${flags.dir ? `--dir ${flags.dir}` : `--url ${flags.url}`}\` in CI.`,
      ),
    );
  });

cli
  .command('update', 'Check npm for a newer pagetrace and install it')
  .option('--check', 'Only report whether an update exists')
  .action(async (flags) => {
    const latest = await latestVersion('pagetrace');

    if (!isNewer(latest, __VERSION__)) {
      console.log(pc.green(`pagetrace ${__VERSION__} is the latest version.`));
      return;
    }
    console.log(pc.yellow(`Update available: ${__VERSION__} → ${latest}`));
    if (flags.check) return;

    // Installing globally over a project-local copy would leave the version the
    // project actually runs untouched, so hand that case back to the user.
    if (process.argv[1]?.startsWith(process.cwd())) {
      console.log(
        pc.dim('This is a project-local install. Update it with your package manager, e.g.'),
      );
      console.log(`  npm install -D pagetrace@${latest}`);
      return;
    }

    const { status, error } = spawnSync('npm', ['install', '-g', `pagetrace@${latest}`], {
      stdio: 'inherit',
    });
    if (error || status !== 0) {
      throw new Error(`npm install failed. Run \`npm install -g pagetrace@${latest}\` yourself.`);
    }
    console.log(pc.green(`Updated to pagetrace ${latest}.`));
  });

cli.help();
cli.version(__VERSION__);

async function main() {
  try {
    cli.parse(process.argv, { run: false });

    // cac prints nothing for a bare or misspelled invocation, which reads as a
    // silent success. Show the command list instead, and fail on a bad name.
    if (!cli.matchedCommand) {
      if (cli.options.help || cli.options.version) return;
      cli.outputHelp();
      if (cli.args[0]) {
        console.error(pc.red(`\nUnknown command "${cli.args[0]}".`));
        process.exitCode = EXIT_FAILURE;
      }
      return;
    }

    await cli.runMatchedCommand();
  } catch (error) {
    console.error(pc.red((error as Error).message));
    process.exitCode = EXIT_FAILURE;
  }
}

void main();
