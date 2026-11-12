// PreToolUse on Bash: warn (and sometimes block) operations on protected branches.
// Protected branches: main, master, production, release, prod
// Behavior:
//   - HARD BLOCK: any push --force to a protected branch
//   - HARD BLOCK: git commit directly on a protected branch (no -m needed to detect)
//   - WARN: any other git operation on a protected branch
const { spawnSync } = require('child_process');

const PROTECTED = /^(main|master|production|release|prod)$/;

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);
    const cmd = String(i.tool_input?.command || '');
    if (!/\bgit\b/.test(cmd)) { process.stdout.write(d); return; }

    // Get current branch (best-effort)
    let branch = '';
    try {
      const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
      branch = (r.stdout || '').trim();
    } catch (e) {}

    const onProtected = PROTECTED.test(branch);

    // Hard block: force push to protected branch (regardless of which branch we're on).
    // Judge each shell segment on its own, so `git push origin main && git worktree remove --force x`
    // or `git push ... && rm -f prod.log` is not mistaken for a force push.
    const segments = cmd.split(/&&|\|\||[;|\n]/);
    const isForcePushToProtected = segments.some(seg => {
      if (!/\bgit\s+push\b/.test(seg)) return false;
      const args = seg.slice(seg.search(/\bgit\s+push\b/)).trim().split(/\s+/).slice(2);
      const force = args.some(a => /^(--force|--force-with-lease|--force-if-includes)(=|$)/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a));
      const refs = args.filter(a => !a.startsWith('-'));
      const protectedRef = refs.slice(1).some(r => {
        const plus = r.startsWith('+');
        const dst = r.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
        return PROTECTED.test(dst) && (force || plus);
      });
      // No refspec given: `git push --force` pushes the current branch
      const bareOnProtected = force && refs.length <= 1 && onProtected;
      return protectedRef || bareOnProtected;
    });
    if (isForcePushToProtected) {
      process.stderr.write(`[Hook] BLOCKED: Force push to a protected branch is not allowed.\n`);
      process.exit(2);
    }

    // Hard block: commit directly on a protected branch
    if (onProtected && /git\s+commit\b/.test(cmd) && !/--amend.*--no-edit/.test(cmd)) {
      process.stderr.write(`[Hook] BLOCKED: You are on '${branch}' (protected). Create a feature branch first:\n`);
      process.stderr.write(`        git checkout -b your-feature-name\n`);
      process.exit(2);
    }

    // Warn: any other git mutation on a protected branch
    if (onProtected && /git\s+(merge|rebase|reset|cherry-pick|revert|checkout\s+[^-])/.test(cmd)) {
      process.stderr.write(`[Hook] WARNING: You are on '${branch}' (protected). Make sure this is intended.\n`);
    }
  } catch (e) {}
  process.stdout.write(d);
});
