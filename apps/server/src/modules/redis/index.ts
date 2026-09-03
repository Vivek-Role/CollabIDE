/**
 * The Redis module's public surface. Cross-module imports go through this
 * barrel only.
 *
 * What is deliberately NOT here: the envelope codec (encodeFrame/decodeFrame),
 * INSTANCE_ID and docChannel. They are exported from docBus.ts for its own
 * tests; no other module has any business with them.
 */

export {
  closeDocBus,
  publishDoc,
  subscribeDoc,
  unsubscribeDoc,
  DocFrameKind,
  type DocFrame,
} from './docBus.js';
