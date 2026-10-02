/**
 * updater-commit-paths.test.mjs — apply()'s scoped commit must not depend on
 * the command line holding every path.
 *
 * On Windows a command line over 32767 characters fails with ENAMETOOLONG
 * before git starts. A v1.32.0 → v1.35.0 update staged about 600 paths, then
 * died on `git commit -m … -- <every path>` with "spawnSync git ENAMETOOLONG",
 * and the recovery command it printed was the same command. addPaths() already
 * batches `git add`; a commit cannot be split, so commitPaths() moves a long
 * pathspec to stdin.
 *
 * Linux and macOS accept far longer command lines, so a real-git run alone
 * would pass there with or without the fix. The seam block pins the shape of
 * the call (no path on the command line once the list is long); the real-git
 * blocks prove the stdin route commits exactly the listed files.
 */

import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { pass, fail, makeUpdaterRepo } from './helpers.mjs';
import { gitIn, commitPaths, recoveryCommitCommand, gitHasPathspecFromFile } from '../update-system.mjs';

console.log('\n🧪 Testing commitPaths (scoped commit without a path-per-argv command line)...');

// 700 paths of ~60 characters: about 42k characters, past the 32767 Windows
// limit, and far past ADD_ARGV_BUDGET.
const LONG = Array.from({ length: 700 }, (_, i) =>
  `modes/a-deliberately-long-system-file-name-${String(i).padStart(4, '0')}.md`);
const SHORT = ['AGENTS.md', 'modes/oferta.md'];

// ── 1. the call shape, through the seams ─────────────────────────────────
{
  const recorder = (version) => {
    const calls = { argv: [], stdin: [] };
    const ctx = {
      git: (...args) => {
        if (args[0] === '--version') return `git version ${version}`;
        calls.argv.push(args);
        return '';
      },
      gitInput: (input, ...args) => { calls.stdin.push({ input, args }); return ''; },
    };
    return { calls, ctx };
  };

  {
    const { calls, ctx } = recorder('2.51.0');
    commitPaths('msg', SHORT, ctx);
    const [args] = calls.argv;
    if (calls.stdin.length === 0 && args && SHORT.every((p) => args.includes(p)) && args.includes('--literal-pathspecs')) {
      pass('a short list keeps the argv form, literal');
    } else {
      fail(`short list: ${JSON.stringify(calls)}`);
    }
  }

  {
    const { calls, ctx } = recorder('2.51.0');
    commitPaths('msg', LONG, ctx);
    const [call] = calls.stdin;
    const onArgv = call ? LONG.filter((p) => call.args.includes(p)).length : -1;
    const listed = call ? call.input.split('\0').filter(Boolean) : [];
    if (calls.argv.length === 0 && call && onArgv === 0
        && listed.length === LONG.length && listed.every((p, i) => p === LONG[i])
        && call.args.includes('--pathspec-from-file=-') && call.args.includes('--pathspec-file-nul')
        && call.args.includes('--literal-pathspecs')) {
      pass(`a long list goes through stdin: ${LONG.length} paths NUL-separated, none on the command line`);
    } else {
      fail(`long list: argv calls=${calls.argv.length}, stdin calls=${calls.stdin.length}, paths on argv=${onArgv}, listed=${listed.length}`);
    }
  }

  {
    const { calls, ctx } = recorder('2.20.1');
    commitPaths('msg', LONG, ctx);
    if (calls.stdin.length === 0 && calls.argv.length === 1) {
      pass('git older than 2.25 (no --pathspec-from-file) keeps the argv form');
    } else {
      fail(`old git: ${JSON.stringify({ argv: calls.argv.length, stdin: calls.stdin.length })}`);
    }
  }

  const probe = (v) => gitHasPathspecFromFile(() => `git version ${v}`);
  if (probe('2.25.0') && probe('2.51.0.windows.1') && probe('3.0.0') && !probe('2.24.4') && !probe('1.8.3.1')) {
    pass('the version probe draws the line at 2.25');
  } else {
    fail('the version probe misreads a git version');
  }
}

// A repo holding the LONG files plus two literal-pathspec traps, committed once.
const makeRepo = () => {
  const repo = makeUpdaterRepo(gitIn, { prefix: 'co-commitpaths-', includeRoot: true });
  mkdirSync(join(repo.dir, 'modes'));
  for (const p of [...LONG, 'a[1].md', 'a1.md', 'unrelated.md']) writeFileSync(join(repo.dir, p), 'v1\n');
  repo.g('add', '-A');
  repo.g('commit', '-qm', 'base');
  for (const p of [...LONG, 'a[1].md', 'a1.md', 'unrelated.md']) writeFileSync(join(repo.dir, p), 'v2\n');
  // The update stages its own paths; something unrelated is staged too, and
  // a1.md is edited but neither staged nor listed.
  repo.g('add', '--', ...LONG.slice(0, 350));
  repo.g('add', '--', ...LONG.slice(350));
  repo.g('add', '--', 'a[1].md', 'unrelated.md');
  return repo;
};
const committed = (g) => new Set(g('show', '--name-only', '-z', '--format=', 'HEAD').split('\0').filter(Boolean));
const staged = (g) => new Set(g('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean));
const LISTED = [...LONG, 'a[1].md'];

// ── 2. real git: the stdin route commits exactly the listed files ─────────
{
  const { dir, g, ctx } = makeRepo();
  try {
    let threw = null;
    try { commitPaths('chore: auto-update system files to v9.9.9', LISTED, ctx); } catch (err) { threw = err; }
    const inCommit = committed(g);
    const stillStaged = staged(g);
    if (!threw && LISTED.every((p) => inCommit.has(p)) && inCommit.size === LISTED.length) {
      pass(`real git: the commit holds exactly the ${LISTED.length} listed files`);
    } else {
      fail(`real git commit: threw=${threw && threw.message.split('\n')[0]} size=${inCommit.size}`);
    }
    if (!inCommit.has('a1.md') && !inCommit.has('unrelated.md') && stillStaged.has('unrelated.md')) {
      pass('real git: literal pathspecs — a[1].md does not sweep in a1.md, and unrelated staged work stays staged');
    } else {
      fail(`real git scoping: a1 committed=${inCommit.has('a1.md')} unrelated committed=${inCommit.has('unrelated.md')} unrelated staged=${stillStaged.has('unrelated.md')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 3. the printed recovery command finishes the same commit ─────────────
{
  const { dir, g, ctx } = makeRepo();
  try {
    const command = recoveryCommitCommand('chore: auto-update system files to v9.9.9', LISTED, ctx);
    const match = /--pathspec-from-file=(\S+)/.exec(command);
    const listFile = match && resolve(dir, match[1]);
    const listed = listFile && existsSync(listFile) ? readFileSync(listFile, 'utf-8').split('\0').filter(Boolean) : [];
    if (match && command.length < 300 && listed.length === LISTED.length) {
      pass(`a long recovery command reads the list from a file (${command.length} characters, not ~${LISTED.join(' ').length})`);
    } else {
      fail(`recovery command: ${command.slice(0, 200)}`);
    }
    // Run it the way a user would paste it: the arguments after `git`.
    const args = command.replace(/^git /, '').match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, ''));
    g(...args);
    const inCommit = committed(g);
    if (LISTED.every((p) => inCommit.has(p)) && !inCommit.has('unrelated.md') && !inCommit.has('a1.md')) {
      pass('running the recovery command commits exactly the listed files');
    } else {
      fail(`recovery run committed ${inCommit.size} files`);
    }
    const shortCommand = recoveryCommitCommand('msg', SHORT, ctx);
    if (!shortCommand.includes('--pathspec-from-file') && shortCommand.includes("'modes/oferta.md'")) {
      pass('a short recovery command keeps the paths inline');
    } else {
      fail(`short recovery command: ${shortCommand}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
