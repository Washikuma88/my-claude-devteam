// PreToolUse on Bash: warn (and sometimes block) operations on protected branches.
// Protected branches: main, master, production, release, prod
// Behavior:
//   - HARD BLOCK: force push to a protected branch (--force / -f / --force-with-lease / +ref),
//                 deleting a protected branch on the remote (`git push origin :main`)
//   - HARD BLOCK: git commit directly on a protected branch (git commit-tree is not a commit on the branch),
//                 except in whitelisted personal config repos (~/.claude, ~/.claude/memory, whitelist.txt)
//   - WARN: merge / rebase / reset / cherry-pick / revert / checkout on a protected branch
// The command is split into shell segments (&& || ; | newline) and only segments that START with
// `git` are judged, so text inside echo / heredoc and unrelated flags in other segments
// (`git worktree remove --force`, `rm -f prod.log`) never trigger a block.
// The branch is looked up in the directory the segment actually runs in: `cd X && git ...`
// and `git -C X ...` use X; otherwise the hook input's cwd.
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

const PROTECTED = /^(main|master|production|release|prod)$/;

function unquote(s) { return s.replace(/^(['"])(.*)\1$/, '$2'); }
function expand(p, base) {
  p = unquote(p);
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(base, p);
}

// Commit whitelist: personal config repos that only have main (~/.claude and its memory/).
// Commits there are allowed; force push / delete is still blocked. Extra repos: one path per line in
// ~/.claude/tools/devteam-patches/whitelist.txt (or the file named by DEVTEAM_BP_WHITELIST). Matched by git toplevel.
function realOr(p) { try { return require('fs').realpathSync(p); } catch (e) { return path.resolve(p); } }
function loadWhitelist() {
  const home = os.homedir();
  const list = [path.join(home, '.claude'), path.join(home, '.claude', 'memory')];
  const file = process.env.DEVTEAM_BP_WHITELIST || path.join(home, '.claude', 'tools', 'devteam-patches', 'whitelist.txt');
  try {
    for (const line of require('fs').readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#')) list.push(expand(t, home));
    }
  } catch (e) {}
  return new Set(list.map(realOr));
}
function isWhitelisted(dir) {
  let top = '';
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', timeout: 5000 });
    top = (r.stdout || '').trim();
  } catch (e) {}
  return !!top && loadWhitelist().has(realOr(top));
}

const branchCache = new Map();
function branchOf(dir) {
  if (branchCache.has(dir)) return branchCache.get(dir);
  let b = '';
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 5000 });
    b = (r.stdout || '').trim();
  } catch (e) {}
  branchCache.set(dir, b);
  return b;
}

// Parse one git invocation: global options (-C dir, -c k=v, --git-dir=...) then subcommand and its args.
function parseGit(tokens, dir) {
  let k = 1;
  while (k < tokens.length && tokens[k].startsWith('-')) {
    const t = tokens[k];
    if (t === '-C') { dir = expand(tokens[k + 1] || '.', dir); k += 2; continue; }
    if (t === '-c') { k += 2; continue; }
    k += 1;
  }
  return { dir, sub: tokens[k] || '', args: tokens.slice(k + 1) };
}

function isForcePushToProtected(args, dir) {
  const force = args.some(a => /^(--force|--force-with-lease|--force-if-includes)(=|$)/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a));
  const refs = args.filter(a => !a.startsWith('-'));
  const protectedRef = refs.slice(1).some(r => {
    const plus = r.startsWith('+');
    const parts = r.replace(/^\+/, '').split(':');
    const dst = parts.pop().replace(/^refs\/heads\//, '');
    const isDelete = parts.length === 1 && parts[0] === '';
    return PROTECTED.test(dst) && (force || plus || isDelete);
  });
  if (args.includes('--delete') || args.includes('-d')) {
    if (refs.slice(1).some(r => PROTECTED.test(r.replace(/^refs\/heads\//, '')))) return true;
  }
  // No refspec given: `git push --force` pushes the current branch
  const bareOnProtected = force && refs.length <= 1 && PROTECTED.test(branchOf(dir));
  return protectedRef || bareOnProtected;
}

// Split on && || ; | newline, but not inside single / double quotes (echo "... && git commit ..." stays one segment).
function segmentsOf(cmd) {
  const out = []; let cur = ''; let q = '';
  for (let k = 0; k < cmd.length; k++) {
    const c = cmd[k];
    if (q) { if (c === q && (q === "'" || cmd[k - 1] !== '\\')) q = ''; cur += c; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && cmd[k + 1] === '&')) {
      out.push(cur); cur = '';
      if ((c === '&' || c === '|') && cmd[k + 1] === c) k++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);
    const cmd = String(i.tool_input?.command || '');
    if (!/\bgit\b/.test(cmd)) { process.stdout.write(d); return; }

    let dir = i.cwd ? path.resolve(i.cwd) : process.cwd();
    for (const raw of segmentsOf(cmd)) {
      const seg = raw.trim().replace(/^[({]\s*/, '');
      const tokens = seg.split(/\s+/).filter(Boolean);
      // skip leading VAR=value assignments
      while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
      if (tokens[0] === 'cd') { dir = expand(tokens[1] || '~', dir); continue; }
      if (tokens[0] !== 'git') continue;

      const g = parseGit(tokens, dir);
      const branch = () => branchOf(g.dir);

      if (g.sub === 'push' && isForcePushToProtected(g.args, g.dir)) {
        process.stderr.write(`[Hook] BLOCKED: Force push (or delete) of a protected branch is not allowed.\n`);
        process.exit(2);
      }

      if (g.sub === 'commit' && PROTECTED.test(branch()) && !(g.args.includes('--amend') && g.args.includes('--no-edit')) && !isWhitelisted(g.dir)) {
        process.stderr.write(`[Hook] BLOCKED: You are on '${branch()}' (protected). Create a feature branch first:\n`);
        process.stderr.write(`        git checkout -b your-feature-name\n`);
        process.exit(2);
      }

      if (/^(merge|rebase|reset|cherry-pick|revert)$/.test(g.sub) || (g.sub === 'checkout' && g.args[0] && !g.args[0].startsWith('-'))) {
        if (PROTECTED.test(branch())) process.stderr.write(`[Hook] WARNING: You are on '${branch()}' (protected). Make sure this is intended.\n`);
      }
    }
  } catch (e) {}
  process.stdout.write(d);
});
