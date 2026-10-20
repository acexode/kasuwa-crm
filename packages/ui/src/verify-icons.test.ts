import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Unit cases for `tools/verify-icons.mjs` beyond what the T-0006 acceptance
 * suite pins: the expression shapes apps/web actually uses (nested ternaries,
 * `??` fallbacks, a multi-line `<Icon>`), and the things that must NOT count
 * (a comment, a component whose name merely starts with `Icon`, a ternary's
 * condition). Each runs the real script against a throwaway `--root`.
 */

const script = resolve(__dirname, '..', '..', '..', 'tools', 'verify-icons.mjs');
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function check(screen: string, filled?: string): { status: number | null; output: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'kasuwa-verify-icons-'));
  dirs.push(root);
  const files: Record<string, string> = {
    'packages/ui/icon-subset.txt': 'home\nclose\nerror\ntimer_off\nsms\nbar_chart\n',
    'apps/web/screen.tsx': screen,
  };
  if (filled !== undefined) files['packages/ui/icon-subset-filled.txt'] = filled;
  for (const [relative, content] of Object.entries(files)) {
    const path = resolve(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  const run = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

function missing(output: string): string[] {
  return [...output.matchAll(/missing icon "([^"]+)"/g)].map((match) => match[1] ?? '');
}

describe('verify-icons: expression shapes', () => {
  it('reads every arm of a nested ternary, and not the literals in its conditions', () => {
    const run = check(
      "const a = <Icon name={expired ? 'timer_off' : method === 'voice' ? 'sms' : 'phone_iphone'} />;\n",
    );
    expect(run.status).toBe(1);
    expect(missing(run.output)).toEqual(['phone_iphone']);
  });

  it('reads the literal fallback of ??, but not an index expression', () => {
    const run = check("const a = <Icon name={METER_ICON['calls'] ?? 'leaderboard'} />;\n");
    expect(missing(run.output)).toEqual(['leaderboard']);
  });

  it('reads a multi-line <Icon> and reports the line the tag opens on', () => {
    const run = check(
      [
        'const a = (',
        '  <Icon',
        "    name={open ? 'home' : 'zz_gone'}",
        '    size="sm"',
        '  />',
        ');',
        '',
      ].join('\n'),
    );
    expect(run.output).toMatch(/missing icon "zz_gone" at apps\/web\/screen\.tsx:2\b/);
  });

  it('reads an expression child of a k-icon element', () => {
    const run = check(`const a = <span className={\`k-icon \${size}\`}>{'zz_child'}</span>;\n`);
    expect(missing(run.output)).toEqual(['zz_child']);
  });

  it('accepts a non-literal name: the IconName union types it', () => {
    const run = check('const a = <Icon name={group.icon} />;\n');
    expect(run.status).toBe(0);
  });
});

describe('verify-icons: what does not count', () => {
  it('ignores a commented-out reference', () => {
    const run = check(
      [
        '// <Icon name="zz_line_comment" />',
        '/* <Icon name="zz_block_comment" /> */',
        'const a = <Icon name="home" />;',
        '',
      ].join('\n'),
    );
    expect(run.status).toBe(0);
  });

  it('ignores a component whose name only starts with Icon', () => {
    const run = check('const a = <IconButton name="zz_not_an_icon" />;\n');
    expect(run.status).toBe(0);
  });

  it('exits 2, not 1, when there is no subset file to check against', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'kasuwa-verify-icons-'));
    dirs.push(root);
    const run = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
    expect(run.status).toBe(2);
  });
});

function missingFilled(output: string): string[] {
  return [...output.matchAll(/missing filled icon "([^"]+)"/g)].map((match) => match[1] ?? '');
}

/**
 * Filled glyphs ship in a second face holding only icon-subset-filled.txt
 * (T-0127, D-L198). A filled name outside it is a blank box, exactly like an
 * unlisted name in the main face, so it fails the same way.
 */
describe('verify-icons: filled icons', () => {
  const FILLED = '# the bell and the bottom tab\nhome\nsms\n';

  it('accepts a filled icon in the filled list', () => {
    const run = check('const a = <Icon name="home" filled />;\n', FILLED);
    expect(run.status).toBe(0);
  });

  it('fails a bare filled prop on a glyph only the main face has', () => {
    const run = check('const a = <Icon name="close" filled />;\n', FILLED);
    expect(run.status).toBe(1);
    expect(missingFilled(run.output)).toEqual(['close']);
  });

  it('checks every arm when filled is an expression, and ignores filled={false}', () => {
    const run = check(
      [
        "const a = <Icon name={tab === 'home' ? 'home' : 'error'} filled={active} />;",
        'const b = <Icon name="close" filled={false} />;',
        '',
      ].join('\n'),
      FILLED,
    );
    expect(run.status).toBe(1);
    expect(missingFilled(run.output)).toEqual(['error']);
  });

  it('treats ligature text in a k-icon-filled element as a filled reference', () => {
    const run = check(
      'const a = <span className="k-icon k-icon-filled">bar_chart</span>;\n',
      FILLED,
    );
    expect(missingFilled(run.output)).toEqual(['bar_chart']);
  });

  it('treats a k-icon-filled class on a self-closing <Icon> as filled', () => {
    const run = check('const a = <Icon name="close" className="k-icon-filled" />;\n', FILLED);
    expect(run.status).toBe(1);
    expect(missingFilled(run.output)).toEqual(['close']);
  });

  it('fails a filled reference when there is no filled list at all', () => {
    const run = check('const a = <Icon name="home" filled />;\n');
    expect(run.status).toBe(1);
    expect(missingFilled(run.output)).toEqual(['home']);
  });

  it('fails a filled list naming a glyph the main subset lacks', () => {
    // filled={active} draws the MAIN face when false, so it must have the glyph too.
    const run = check('const a = <Icon name="home" filled />;\n', 'home\nnotifications\n');
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/filled icon "notifications" is in .* but not in/);
  });

  it('does not mistake a prop that merely starts with filled for the filled prop', () => {
    const run = check('const a = <Icon name="close" filledLabel="x" />;\n', FILLED);
    expect(run.status).toBe(0);
  });
});
