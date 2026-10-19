// Self-test for guard-kill.mjs: `node --test .claude/hooks/guard-kill.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from './guard-kill.mjs';

const refused = [
  'pkill -f "cat" -U $(id -u) 2>/dev/null',
  'pkill -f packages/testing/.bench/up.ts',
  'pkill node',
  'sleep 1; pkill -TERM -f vitest',
  'echo hi && killall node',
  'xargs -r pkill -f',
  'sudo killall Docker',
  'kill -9 -1',
  'kill -- -1',
  'kill 0',
  'osascript -e \'quit app "Docker"\'',
  'docker desktop stop',
  'docker desktop restart',
  '$(pkill -f next-server)',
];

const allowed = [
  'kill 12345',
  'kill -TERM 12345 23456',
  'pkill -P 12345',
  'pkill -TERM -P 12345',
  'pgrep -fl vitest',
  'ps -o pid,command -p 123',
  'git commit -m "docs: never use pkill -f with a short pattern"',
  'docker ps',
  'docker compose down',
  'grep -n "killall" README.md',
];

for (const command of refused) {
  test(`refuses: ${command}`, () => assert.notEqual(verdict(command), null));
}
for (const command of allowed) {
  test(`allows: ${command}`, () => assert.equal(verdict(command), null));
}
