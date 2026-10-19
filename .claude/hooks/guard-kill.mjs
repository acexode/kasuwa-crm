#!/usr/bin/env node
/**
 * PreToolUse hook: refuse shell commands that kill processes by pattern, or
 * that stop Docker Desktop.
 *
 * Why it exists: on 2026-10-18 an agent ran `pkill -f "cat"` to end one hung
 * command. `-f` matches the whole command line, and "/Applications" contains
 * "cat", so it sent SIGTERM to Docker Desktop. The Docker log shows "terminated
 * signal received" half a second later. Every Testcontainers proof stalled until
 * a person restarted Docker. This machine is also shared with another project
 * (the "dialler"), whose processes a pattern can hit just as easily.
 *
 * The rule: kill only processes you started, by pid. So this refuses:
 *   - `killall` in any form;
 *   - `pkill`, except `pkill -P <pid>` (the children of one pid you own);
 *   - `kill -1`, `kill 0` and `kill -- -1` (every process you can signal);
 *   - quitting or killing Docker Desktop (`osascript ... Docker`,
 *     `docker desktop stop|restart`). Agents never start or stop Docker.
 *
 * Like protect-paths.mjs, this is a guardrail against accident, NOT a security
 * control: a session that wanted to could route around it. See README.md.
 * It only looks at command positions (start of the command, or after `;`, `&`,
 * `|`, `(`, a backtick or a newline), so a commit message that merely mentions
 * pkill is not refused.
 */

import { pathToFileURL } from 'node:url';

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
  });
}

// Where a new command can begin, plus wrappers that run the next word.
const START = String.raw`(?:^|[;&|(\x60\n])\s*(?:(?:sudo|exec|env|nohup|time|timeout\s+\S+|xargs(?:\s+-\S+)*)\s+)*`;

const RULES = [
  {
    re: new RegExp(`${START}killall\\b`),
    why: '`killall` kills every process with that name, including other projects’ and Docker’s.',
  },
  {
    // pkill is allowed only as `pkill [-SIGNAL] -P <pid>`: children of one pid.
    re: new RegExp(`${START}pkill\\b(?!(?:\\s+-[A-Z0-9]+)?\\s+-P\\s+\\d+\\s*(?:$|[;&|)\\n]))`),
    why: '`pkill` matches by name or command line. `pkill -f "cat"` matched "/Applications" and killed Docker Desktop on 2026-10-18.',
  },
  {
    re: new RegExp(`${START}kill\\s+(?:-\\S+\\s+)*(?:--\\s+)?(?:-1|0)(?:\\s|$|[;&|)])`),
    why: '`kill -1` / `kill 0` signals every process you can reach.',
  },
  {
    re: /osascript\b[^\n]*\bDocker\b/i,
    why: 'Agents never quit or start Docker Desktop; the user does.',
  },
  {
    re: new RegExp(`${START}docker\\s+desktop\\s+(?:stop|restart|start)\\b`),
    why: 'Agents never quit or start Docker Desktop; the user does.',
  },
];

export function verdict(command) {
  const text = String(command ?? '');
  for (const rule of RULES) {
    if (rule.re.test(text)) return rule.why;
  }
  return null;
}

// Run as a hook only when executed directly, so the rules can be imported in tests.
// pathToFileURL, not string concatenation: the main checkout's path has a space.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    // A hook that cannot parse its input must not block work; it has no opinion.
    process.exit(0);
  }
  const why = verdict(payload?.tool_input?.command);
  if (!why) process.exit(0);
  process.stderr.write(
    `guard-kill: refused. ${why}\n` +
      'Kill only processes you started, by pid: note the pid when you start something (`$!`, or `pgrep -f` to LOOK, never to kill), then `kill <pid>`, or `pkill -P <pid>` for its children.\n' +
      'If Docker is down, say so and wait; never start or stop it.\n',
  );
  // Exit code 2 blocks the tool call and returns stderr to the model.
  process.exit(2);
}
