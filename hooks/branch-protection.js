// PreToolUse on Bash: warn (and sometimes block) operations on protected branches.
// Protected branches: main, master, production, release, prod
// Behavior:
//   - HARD BLOCK: force push to a protected branch (--force / -f / --force-with-lease / +ref),
//                 deleting a protected branch on the remote (`git push origin :main`)
//   - HARD BLOCK: git commit directly on a protected branch (git commit-tree is not a commit on the branch),
//                 except in whitelisted personal config repos (~/.claude, ~/.claude/memory, whitelist.txt)
//   - WARN: merge / rebase / reset / cherry-pick / revert / checkout on a protected branch
// The command is split into shell segments (&& || ; | & newline, quote-aware). Segments starting with `git`
// are parsed word by word, so unrelated flags in other segments (`git worktree remove --force`,
// `rm -f prod.log`) and quoted text (echo "... git push ...") never trigger a block; any other segment that
// still mentions git falls back to the old whole-segment regex (see WRAPPERS / hollow below).
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


// Parse one git invocation: global options (-C dir, -c k=v, --git-dir X, --work-tree X, --namespace X, --opt=val)
// then subcommand and its args. Args are unquoted so "main" / 'main' compare as main.
function parseGit(tokens, dir) {
  let k = 1;
  while (k < tokens.length && tokens[k].startsWith('-')) {
    const t = tokens[k];
    if (t === '-C') { dir = expand(tokens[k + 1] || '.', dir); k += 2; continue; }
    if (t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace' || t === '--exec-path' || t === '--config-env') { k += 2; continue; }
    k += 1;
  }
  return { dir, sub: unquote(tokens[k] || ''), args: tokens.slice(k + 1).map(unquote) };
}

function isForcePushToProtected(args, branch) {
  // Quote characters anywhere in a token are dropped (main:refs/heads/"main" -> main:refs/heads/main).
  args = args.map(a => a.replace(/["']/g, ''));
  const force = args.some(a => /^(--force|--force-with-lease|--force-if-includes)(=|$)/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a));
  // Redirections (2>&1, >/dev/null, &>x, and the word after a bare > / >> / <) are not refs.
  const refs = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (/^\d*[<>]+&?$/.test(a) || a === '&>' || a === '&>>') { k++; continue; }
    if (/[<>]/.test(a) || a.startsWith('-')) continue;
    refs.push(a);
  }
  // HEAD / @ as destination means the current branch
  const norm = (x) => (x === 'HEAD' || x === '@' ? branch() : x.replace(/^refs\/heads\//, ''));
  const protectedRef = refs.slice(1).some(r => {
    const plus = r.startsWith('+');
    const parts = r.replace(/^\+/, '').split(':');
    const dst = norm(parts.pop());
    const isDelete = parts.length === 1 && parts[0] === '';
    return PROTECTED.test(dst) && (force || plus || isDelete);
  });
  if (args.includes('--delete') || args.includes('-d')) {
    if (refs.slice(1).some(r => PROTECTED.test(norm(r)))) return true;
  }
  // No refspec given: `git push --force` pushes the current branch
  const bareOnProtected = force && refs.length <= 1 && PROTECTED.test(branch());
  return protectedRef || bareOnProtected;
}

// Split on && || ; | & newline, but not inside single / double quotes (echo "... && git commit ..." stays one segment).
// `&` that is part of a redirection (2>&1, &>file, >&2) is not a separator.
function segmentsOf(cmd) {
  const out = []; let cur = ''; let q = '';
  for (let k = 0; k < cmd.length; k++) {
    const c = cmd[k];
    if (q) { if (c === q && (q === "'" || cmd[k - 1] !== '\\')) q = ''; cur += c; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    const redirAmp = c === '&' && cmd[k + 1] !== '&' && (cmd[k - 1] === '>' || cmd[k - 1] === '<' || cmd[k + 1] === '>');
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && !redirAmp)) {
      out.push(cur); cur = '';
      if ((c === '&' || c === '|') && cmd[k + 1] === c) k++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Only segments whose first word is `git` (or a path ending in /git) or `cd` are parsed word by word.
// Any other segment that still contains the word git after quoted text is hollowed out goes to the old
// whole-segment regex (better a false block than a miss): if/then/else/do/until, `!`, timeout/stdbuf/caffeinate,
// env/sudo/command ... prefixes. echo "... git push ..." hollows to echo "" and is not judged.
// Wrappers that run a quoted string (eval, sh/bash/zsh -c ...) and command substitution ($( ) / backticks)
// go to the old regex whenever the raw segment mentions git, since hollowing would hide it.
const WRAPPERS = new Set(['eval', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'command', 'sudo', 'env', 'time', 'nohup', 'xargs', 'exec', 'nice', 'builtin', 'timeout', 'stdbuf', 'caffeinate', 'watch']);
function hollow(seg) {
  let out = ''; let q = '';
  for (let k = 0; k < seg.length; k++) {
    const c = seg[k];
    if (q) { if (c === q && (q === "'" || seg[k - 1] !== '\\')) { q = ''; out += c; } continue; }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    out += c;
  }
  return out;
}
function firstWord(t) { return unquote(t || '').replace(/^\\/, ''); }
const LEGACY_FORCE = /\bgit\b.*\bpush\b.*(--force|--force-with-lease|\s-[a-zA-Z]*f\b).*\b(main|master|production|release|prod)\b/;
const LEGACY_DELETE = /\bgit\b.*\bpush\b.*(\s["']?[+:]["']?(refs\/heads\/)?(main|master|production|release|prod)\b|--delete\b.*\b(main|master|production|release|prod)\b)/;
const LEGACY_BARE_FORCE = /\bgit\b.*\bpush\b.*(--force|--force-with-lease|\s-[a-zA-Z]*f\b)/;
const LEGACY_COMMIT = /\bgit\b.*\bcommit(\s|$|["'`)])/;

function block(msg) { process.stderr.write(msg); process.exit(2); }
const FORCE_MSG = `[Hook] BLOCKED: Force push (or delete) of a protected branch is not allowed.\n`;
function commitMsg(b) { return `[Hook] BLOCKED: You are on '${b}' (protected). Create a feature branch first:\n        git checkout -b your-feature-name\n`; }

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);
    const cmd = String(i.tool_input?.command || '');
    if (!/\bgit\b/.test(cmd)) { process.stdout.write(d); return; }

    const base = i.cwd ? path.resolve(i.cwd) : process.cwd();
    let dir = base;
    // Branch of a directory; when the directory cannot be resolved (cd "$REPO", cd $(...), not a repo),
    // fall back to the hook input's cwd instead of treating an empty branch as "not protected".
    const branchAt = (x) => branchOf(x) || branchOf(base);
    const whitelistedAt = (x) => (branchOf(x) ? isWhitelisted(x) : isWhitelisted(base));

    for (const raw of segmentsOf(cmd)) {
      const seg = raw.trim().replace(/^[({]\s*/, '');
      const tokens = seg.split(/\s+/).filter(Boolean);
      // skip leading VAR=value assignments
      while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
      if (!tokens.length) continue;

      const t0 = firstWord(tokens[0]);
      const isGit = /(^|\/)git$/.test(t0);
      const legacy = (text) => {
        if (LEGACY_FORCE.test(text) || LEGACY_DELETE.test(text)) block(FORCE_MSG);
        if (LEGACY_BARE_FORCE.test(text) && PROTECTED.test(branchAt(dir))) block(FORCE_MSG);
        if (LEGACY_COMMIT.test(text) && PROTECTED.test(branchAt(dir)) && !whitelistedAt(dir)) block(commitMsg(branchAt(dir)));
      };

      if (t0 === 'cd') {
        const target = tokens[1] || '~';
        // $VAR / $(...) / backticks: cannot resolve, keep judging against the hook input's cwd
        dir = /[$`]/.test(target) ? base : expand(target, dir);
        continue;
      }
      if (!isGit) {
        const subst = /\$\(|`/.test(seg);
        if (/\bgit\b/.test(hollow(seg)) || ((subst || WRAPPERS.has(t0)) && /\bgit\b/.test(seg))) legacy(seg);
        // $g push --force ...: the program name is a variable, judge as if it were git
        else if (t0.startsWith('$')) legacy('git ' + seg);
        continue;
      }
      if (/\$\(|`/.test(seg)) { legacy(seg); continue; }

      const g = parseGit(tokens, dir);
      const branch = () => branchAt(g.dir);

      if (g.sub === 'push' && isForcePushToProtected(g.args, branch)) block(FORCE_MSG);

      if (g.sub === 'commit' && PROTECTED.test(branch()) && !(g.args.includes('--amend') && g.args.includes('--no-edit')) && !whitelistedAt(g.dir)) {
        block(commitMsg(branch()));
      }

      if (/^(merge|rebase|reset|cherry-pick|revert)$/.test(g.sub) || (g.sub === 'checkout' && g.args[0] && !g.args[0].startsWith('-'))) {
        if (PROTECTED.test(branch())) process.stderr.write(`[Hook] WARNING: You are on '${branch()}' (protected). Make sure this is intended.\n`);
      }
    }
  } catch (e) {}
  process.stdout.write(d);
});
