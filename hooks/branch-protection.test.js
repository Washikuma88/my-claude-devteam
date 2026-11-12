// 執行：node --test hooks/branch-protection.test.js
// 在暫存 git repo（分別切到 main 與 feature 分支）裡餵 hook 指令，看 exit code：2＝擋，0＝放行。
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, 'branch-protection.js');

function repoOn(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-test-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', branch);
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

function run(cmd, cwd) {
  const r = spawnSync('node', [HOOK], {
    cwd, input: JSON.stringify({ tool_input: { command: cmd } }), encoding: 'utf8',
  });
  return r.status;
}

const onMain = repoOn('main');
const onFeature = repoOn('feature-x');

const cases = [
  // [說明, 指令, 所在 repo, 期望 exit]
  ['worktree remove --force 放行', 'git worktree remove --force /tmp/wt-main', onFeature, 0],
  ['push main 後接 worktree remove --force 放行（2026-11 誤擋實例）',
    'cd /x && git push origin main 2>&1 | tail -1 && git worktree remove --force /tmp/scratchpad/wt-verify; ~/.backtest/deploy-worker.sh 2>&1 | tail -3; echo "設計師 PASS → 合 main 已 push → deploy" >> state.md', onFeature, 0],
  ['push 後 rm -f 檔名含 prod 放行', 'git push origin feature-x && rm -f prod.log', onFeature, 0],
  ['git push --force 在 main 上擋', 'git push --force', onMain, 2],
  ['git push -f origin main 擋', 'git push -f origin main', onFeature, 2],
  ['git push --force-with-lease origin master 擋', 'git push --force-with-lease origin master', onFeature, 2],
  ['git push origin +main 擋', 'git push origin +main', onFeature, 2],
  ['git push --force origin HEAD:production 擋', 'git push --force origin HEAD:production', onFeature, 2],
  ['複合指令裡的 force push main 照擋', 'git fetch && git push --force origin main', onFeature, 2],
  ['git push --force 在 feature 分支放行', 'git push --force', onFeature, 0],
  ['git push --force origin feature-x 放行', 'git push --force origin feature-x', onFeature, 0],
  ['main 上直接 commit 擋（原行為保留）', 'git commit -m x', onMain, 2],
];

for (const [name, cmd, cwd, want] of cases) {
  test(name, () => assert.strictEqual(run(cmd, cwd), want));
}
