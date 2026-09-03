/**
 * The shared UI primitives.
 *
 * `components/` had no barrel before module 10.1 — Dialog was imported by path
 * from four places. Those paths still work and were deliberately not rewritten
 * in 10.1; modules 10.2–10.6 switch each file over as they touch it, so no
 * module carries a rename sweep it did not otherwise need.
 *
 * Decision A3: six primitives, and no more. There is intentionally no Spinner
 * (it is Button's `loading` prop), no StatusDot (Badge's `dot` variant) and no
 * role-pill component (Badge with a tone). If a seventh looks necessary, that
 * is a conversation, not a file.
 */
export { Alert } from './Alert';
export { Badge } from './Badge';
export { Button } from './Button';
export type { ButtonProps } from './Button';
export { Dialog } from './Dialog';
export { EmptyState } from './EmptyState';
export { Field } from './Field';
export type { FieldProps } from './Field';
export * from './icons';
