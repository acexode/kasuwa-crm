import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Avatar,
  Button,
  Checkbox,
  Chip,
  CountBadge,
  IconButton,
  Kbd,
  Pill,
  Radio,
  SegmentedControl,
  Select,
  Switch,
  Tabs,
  Tag,
  TextField,
} from './index';

/**
 * What each control renders: its semantics, its states and the utilities
 * that carry the v1.1 spec. The computed pixels are the e2e suite's job
 * (tests/e2e/design-components.spec.ts); these pin what decides them, and
 * fail on the old hand-rolled class strings' mistakes (opacity fades, outline
 * focus, pill tabs).
 */

const html = (element: ReactElement): string => renderToStaticMarkup(element);

/** The class list of the first element matching `tag` (optionally with an attribute). */
function classesOf(markup: string, tag: string, attribute = ''): string[] {
  const match = new RegExp(`<${tag}\\b[^>]*${attribute}[^>]*class="([^"]*)"`).exec(markup);
  return (match?.[1] ?? '').split(' ');
}

describe('Button', () => {
  it('is 44px, 0 12px, radius 8, 15/600 and a real button that does not submit', () => {
    const markup = html(createElement(Button, { variant: 'primary', children: 'Save' }));
    expect(markup).toMatch(/^<button type="button"/);
    expect(classesOf(markup, 'button')).toEqual(
      expect.arrayContaining(['h-control-base', 'px-3', 'rounded-md', 'text-label']),
    );
  });

  it('draws disabled with the disabled tokens, never an opacity fade', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      const classes = classesOf(
        html(createElement(Button, { variant, disabled: true, children: 'Save' })),
        'button',
      );
      expect(classes, variant).toContain('disabled:text-disabled-text');
      expect(
        classes.filter((name) => name.includes('opacity')),
        variant,
      ).toEqual([]);
    }
    expect(
      classesOf(html(createElement(Button, { variant: 'primary', children: 'x' })), 'button'),
    ).toContain('disabled:bg-disabled-bg');
  });

  it('shows focus as the ring utility on :focus-visible, never an outline', () => {
    const classes = classesOf(html(createElement(Button, { children: 'Save' })), 'button');
    expect(classes).toContain('is-focus-visible:ring-focus');
    expect(classes.filter((name) => name.includes('outline'))).toEqual([]);
  });

  it('hovers and presses in the v1.1 colours, moving down 1px when pressed', () => {
    const primary = classesOf(
      html(createElement(Button, { variant: 'primary', children: 'x' })),
      'button',
    );
    expect(primary).toEqual(
      expect.arrayContaining([
        'is-hover:bg-primary-hover',
        'is-active:bg-primary-active',
        'is-active:translate-y-px',
      ]),
    );
    const ghost = classesOf(
      html(createElement(Button, { variant: 'ghost', children: 'x' })),
      'button',
    );
    expect(ghost).toContain('is-hover:bg-primary-soft');
    const secondary = classesOf(html(createElement(Button, { children: 'x' })), 'button');
    expect(secondary).toContain('is-hover:bg-surface-sunken');
  });

  it('is 36px only from md up, and keeps a 44px band for the finger', () => {
    const classes = classesOf(
      html(createElement(Button, { size: 'compact', children: 'x' })),
      'button',
    );
    expect(classes).toEqual(
      expect.arrayContaining(['h-control-base', 'md:h-control-sm', 'md:before:-inset-y-1']),
    );
  });

  it('keeps its width while loading: both labels stay in the layout, one invisible', () => {
    const idle = html(
      createElement(Button, { variant: 'primary', loadingLabel: 'Saving', children: 'Save' }),
    );
    const busy = html(
      createElement(Button, {
        variant: 'primary',
        loading: true,
        loadingLabel: 'Saving',
        children: 'Save',
      }),
    );
    for (const markup of [idle, busy]) {
      expect(markup).toContain('>Save<');
      expect(markup).toContain('Saving');
    }
    expect(idle).not.toContain('aria-busy');
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('aria-disabled="true"');
    expect(busy).toContain('animate-spin');
  });

  it('keeps its accessible name while loading without a loading label', () => {
    const busy = html(createElement(Button, { loading: true, children: 'Save' }));
    expect(busy).toContain('opacity-0');
    expect(busy).not.toContain('invisible');
    expect(busy).toContain('>Save<');
  });
});

describe('IconButton', () => {
  it('is a 44px square with a 22px glyph and a required accessible name', () => {
    const markup = html(createElement(IconButton, { icon: 'call', label: 'Call' }));
    expect(markup).toContain('aria-label="Call"');
    expect(classesOf(markup, 'button')).toContain('size-control-base');
    expect(markup).toMatch(
      /<span aria-hidden="true" class="k-icon[^"]*text-icon-22[^"]*">call<\/span>/,
    );
  });

  it('announces a pressed toggle and draws it primary', () => {
    const markup = html(createElement(IconButton, { icon: 'mic', label: 'Mute', pressed: true }));
    expect(markup).toContain('aria-pressed="true"');
    expect(classesOf(markup, 'button')).toContain('aria-pressed:bg-primary');
  });
});

describe('TextField', () => {
  it('ties the label, hint and error to the control', () => {
    const markup = html(
      createElement(TextField, {
        id: 'email',
        label: 'Email',
        hint: 'Work address',
        error: 'Enter a full email',
      }),
    );
    expect(markup).toContain('<label for="email"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-describedby="email-error email-hint"');
    expect(markup).toContain('id="email-error"');
  });

  it('draws an error as a 2px danger edge and a trailing error glyph', () => {
    const markup = html(createElement(TextField, { label: 'Email', error: 'Wrong' }));
    expect(classesOf(markup, 'input')).toEqual(
      expect.arrayContaining(['border-2', 'border-danger', 'pe-10']),
    );
    expect(markup).toMatch(/class="k-icon[^"]*text-icon-20[^"]*text-danger-text[^"]*">error</);
  });

  it('focuses with the field ring on any focus, and hovers to text-2', () => {
    const classes = classesOf(html(createElement(TextField, { label: 'Name' })), 'input');
    expect(classes).toEqual(
      expect.arrayContaining([
        'is-focus:field-focus',
        'is-hover:border-text-2',
        'border-border-strong',
      ]),
    );
    expect(classes).not.toContain('aria-invalid');
  });

  it('greys the label as well as the control when disabled', () => {
    const markup = html(createElement(TextField, { label: 'Account ID', disabled: true }));
    expect(classesOf(markup, 'label')).toContain('text-disabled-text');
    expect(classesOf(markup, 'input')).toContain('disabled:bg-disabled-bg');
  });

  it('passes data attributes to the label and the status glyph', () => {
    const markup = html(
      createElement(TextField, {
        label: 'Email',
        error: 'Wrong',
        labelAttributes: { 'data-gallery': 'the-label' },
        statusIconAttributes: { 'data-gallery': 'the-icon' },
      }),
    );
    expect(markup).toMatch(/<label[^>]*data-gallery="the-label"/);
    expect(markup).toMatch(/data-gallery="the-icon">error</);
  });
});

describe('Select', () => {
  it('is a native select with the field look and a trailing chevron', () => {
    const markup = html(
      createElement(Select, {
        id: 'queue',
        label: 'Queue',
        children: createElement('option', { value: 'a' }, 'Lagos Sales'),
      }),
    );
    expect(markup).toContain('<select id="queue"');
    expect(classesOf(markup, 'select')).toEqual(
      expect.arrayContaining(['appearance-none', 'h-control-base', 'is-focus:field-focus']),
    );
    expect(markup).toContain('>expand_more<');
  });
});

describe('Checkbox, Radio and Switch', () => {
  it('keeps native inputs for the checkbox and radio, on a 44px row', () => {
    const checkbox = html(createElement(Checkbox, { label: 'Accept terms' }));
    expect(checkbox).toContain('type="checkbox"');
    expect(classesOf(checkbox, 'label')).toContain('min-h-touch');
    expect(classesOf(checkbox, 'input')).toEqual(
      expect.arrayContaining(['size-5', 'border-2', 'border-border-strong', 'rounded-sm']),
    );
    const radio = html(createElement(Radio, { label: 'SMS', name: 'channel' }));
    expect(radio).toContain('type="radio"');
    expect(classesOf(radio, 'input')).toContain('rounded-full');
  });

  it('marks a required box left unticked as invalid, in words and colour', () => {
    const markup = html(createElement(Checkbox, { label: 'Accept terms', invalid: true }));
    expect(markup).toContain('aria-invalid="true"');
    expect(classesOf(markup, 'label')).toContain('text-danger-text');
  });

  it('gives a label-less checkbox a 44px square target', () => {
    const markup = html(createElement(Checkbox, { 'aria-label': 'Select row' }));
    expect(classesOf(markup, 'label')).toContain('min-w-touch');
  });

  it('renders the switch as role=switch with its state and its label', () => {
    const off = html(createElement(Switch, { label: 'Play ring sound' }));
    expect(off).toContain('role="switch"');
    expect(off).toContain('aria-checked="false"');
    expect(off).toMatch(/aria-labelledby="([^"]+)"[\s\S]*id="\1"/);
    expect(classesOf(off, 'button')).toEqual(
      expect.arrayContaining(['h-6.5', 'w-touch', 'bg-border-strong']),
    );
    const on = html(createElement(Switch, { label: 'Auto-assign', defaultChecked: true }));
    expect(on).toContain('aria-checked="true"');
    expect(classesOf(on, 'button')).toContain('bg-primary');
    expect(on).toContain('translate-x-4.5');
  });
});

describe('Chip, Pill, Tag, CountBadge and Kbd', () => {
  it('draws the filter chip at 36px, 10/8 padding, with an active primary state', () => {
    const rest = classesOf(
      html(createElement(Chip, { icon: 'person', children: 'Owner' })),
      'button',
    );
    expect(rest).toEqual(
      expect.arrayContaining([
        'h-control-sm',
        'rounded-full',
        'ps-2.5',
        'pe-2',
        'border-border-strong',
      ]),
    );
    const active = classesOf(
      html(createElement(Chip, { active: true, children: 'Source' })),
      'button',
    );
    expect(active).toEqual(expect.arrayContaining(['border-primary', 'bg-primary-soft']));
  });

  it('pads pills and tags 3px 10px at 12/700', () => {
    for (const markup of [
      html(createElement(Pill, { tone: 'success', children: 'Resolved' })),
      html(createElement(Tag, { tone: 'primary', children: 'VIP' })),
    ]) {
      expect(classesOf(markup, 'span')).toEqual(
        expect.arrayContaining(['px-2.5', 'py-0.75', 'text-caption', 'font-bold']),
      );
    }
    expect(
      classesOf(html(createElement(Tag, { tone: 'accent', children: 'Hot' })), 'span'),
    ).toContain('rounded-sm');
  });

  it('sizes the count badge 20px at 11/700', () => {
    const classes = classesOf(html(createElement(CountBadge, { children: '9+' })), 'span');
    expect(classes).toEqual(
      expect.arrayContaining(['h-5', 'min-w-5', 'text-micro', 'rounded-full']),
    );
  });

  it('sets a kbd in mono 11 with a border-strong edge', () => {
    const markup = html(createElement(Kbd, { children: 'Esc' }));
    expect(markup).toMatch(/^<kbd /);
    expect(classesOf(markup, 'kbd')).toEqual(
      expect.arrayContaining(['font-mono', 'text-micro', 'font-normal', 'border-border-strong']),
    );
  });
});

describe('SegmentedControl and Tabs', () => {
  it('is a radio group with one tab stop, on the selected option', () => {
    const markup = html(
      createElement(SegmentedControl, {
        'aria-label': 'Density',
        defaultValue: 'dense',
        options: [
          { value: 'comfortable', label: 'Comfortable' },
          { value: 'dense', label: 'Dense', attributes: { 'data-gallery': 'x' } },
        ],
      }),
    );
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="Density"');
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup).toMatch(
      /aria-checked="true" tabindex="0"[^>]*class="[^"]*bg-surface text-text shadow-1[^"]*" data-gallery="x"/,
    );
    expect(markup).toMatch(/aria-checked="false" tabindex="-1"[^>]*text-text-2/);
  });

  it('draws tabs as underline tabs: no fill, 700 over a 3px primary bar when selected', () => {
    const markup = html(
      createElement(Tabs, {
        'aria-label': 'Record',
        id: 'rec',
        defaultValue: 'timeline',
        items: [
          { value: 'overview', label: 'Overview' },
          { value: 'timeline', label: 'Timeline', count: '24', controls: 'panel-timeline' },
        ],
      }),
    );
    expect(markup).toContain('role="tablist"');
    expect(markup).toMatch(/id="rec-timeline" type="button" role="tab" aria-selected="true"/);
    expect(markup).toContain('aria-controls="panel-timeline"');
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    const selected = classesOf(markup, 'button', 'aria-selected="true"');
    expect(selected).toEqual(
      expect.arrayContaining([
        'font-bold',
        'text-primary-text',
        'after:h-0.75',
        'after:bg-primary',
        'bg-transparent',
      ]),
    );
    expect(selected.filter((name) => /^bg-primary/.test(name))).toEqual([]);
    const rest = classesOf(markup, 'button', 'aria-selected="false"');
    expect(rest).toEqual(expect.arrayContaining(['font-medium', 'text-text-2']));
  });
});

describe('Avatar', () => {
  it('shows initials on the hashed tone, decorative unless labelled', () => {
    const markup = html(createElement(Avatar, { name: 'Adaeze Okonkwo' }));
    expect(markup).toContain('>AO<');
    expect(markup).toContain('aria-hidden="true"');
    const labelled = html(
      createElement(Avatar, {
        name: 'Adaeze Okonkwo',
        label: 'Adaeze Okonkwo, available',
        presence: 'available',
      }),
    );
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('bg-success');
  });

  it('is 44px at 14/700 or 32px at 12/700', () => {
    expect(classesOf(html(createElement(Avatar, { name: 'K M' })), 'span')).toEqual(
      expect.arrayContaining(['size-touch', 'text-body-sm', 'font-bold', 'rounded-full']),
    );
    expect(classesOf(html(createElement(Avatar, { name: 'K M', size: 32 })), 'span')).toEqual(
      expect.arrayContaining(['size-8', 'text-caption', 'font-bold']),
    );
  });

  it('greys an offline avatar instead of colouring it', () => {
    const classes = classesOf(
      html(createElement(Avatar, { name: 'Kwame Mensah', presence: 'offline' })),
      'span',
    );
    expect(classes).toEqual(expect.arrayContaining(['bg-surface-sunken', 'text-text-muted']));
    expect(
      classes.filter((name) => name.endsWith('-soft') || name.endsWith('-soft-strong')),
    ).toEqual([]);
  });

  it('falls back to a person glyph when the name has no letters', () => {
    expect(html(createElement(Avatar, { name: '—' }))).toContain('>person<');
  });
});

describe('the component sources', () => {
  const dir = __dirname;
  const sources = readdirSync(dir).filter(
    (file) => /\.tsx?$/.test(file) && !file.includes('.test.'),
  );

  it('hold no user-facing words of their own', () => {
    // Every visible string is a prop, so it is the caller's i18n string. A
    // JSX text node with a letter in it would be copy nobody can translate.
    const offenders = sources.filter((file) =>
      /> *[\p{L}][^<{]*</u.test(
        readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('style disabled controls with tokens, never with opacity', () => {
    const offenders = sources.filter((file) =>
      /disabled:opacity|aria-disabled:opacity/.test(readFileSync(join(dir, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
