/**
 * @kasuwa/ui/components: the controls, built once to the v1.1 Components page
 * (T-0128, D-L200).
 *
 * A separate entry point from `@kasuwa/ui`. The root exports the token tables
 * and the CSS and preset generators; a client component importing it would
 * ship them on every page. Nothing in this directory imports the root, the
 * colour tables or the generators at run time (type-only imports are fine),
 * and nothing in it carries a colour or pixel literal: every value is a
 * Tailwind utility from the T-0127 preset. Both are asserted by
 * tests/acceptance/design-system/components-1.acceptance.test.ts.
 *
 * React is a peer dependency. Interactive components that keep state
 * (Checkbox, Switch, SegmentedControl, Tabs) are client modules; the rest
 * render on the server too.
 *
 * Every visible string comes in through props: the components never hold
 * copy of their own, so every word is the caller's @kasuwa/i18n string.
 */
export { Avatar, type AvatarPresence, type AvatarProps, type AvatarSize } from './avatar';
export { AVATAR_TONES, avatarTone, initials, type AvatarTone } from './avatar-identity';
export {
  CountBadge,
  Kbd,
  Pill,
  Tag,
  type CountBadgeProps,
  type CountBadgeTone,
  type KbdProps,
  type PillProps,
  type PillTone,
  type TagProps,
  type TagSize,
  type TagTone,
} from './badges';
export {
  Button,
  IconButton,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  type IconButtonProps,
  type IconButtonVariant,
} from './button';
export { Checkbox, type CheckboxProps } from './checkbox';
export { Chip, type ChipProps } from './chip';
export type { DataAttributes } from './class-names';
export { Radio, type RadioProps } from './radio';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from './segmented-control';
export { Select, type SelectProps } from './select';
export { Switch, type SwitchProps } from './switch';
export { Tabs, type TabItem, type TabsProps } from './tabs';
export { TextField, type TextFieldProps } from './text-field';
