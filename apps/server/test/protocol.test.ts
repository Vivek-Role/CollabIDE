import { describe, expect, it } from 'vitest';

import {
  CloseCode,
  DOC_ID_SEPARATOR,
  MAX_DOC_ID_PART_LENGTH,
  MessageType,
  WS_DOC_PARAM,
  WS_PATH,
  Y_TEXT_KEY,
  closeReason,
  makeDocId,
  parseDocId,
} from '@collab/shared';

/**
 * Pure unit tests for the WS contract — no database, no HTTP, no socket. Same
 * shape as paths.test.ts, and for the same reason: parseDocId reads input off
 * the network, so its rejection table is worth enumerating cheaply.
 *
 * These live in the server suite rather than in packages/shared because that
 * package has no test runner, and installing a second vitest for two pure
 * functions would cost more than it is worth. Note that @collab/shared resolves
 * through dist — run `npm run build` before `npm test`.
 */

/** Real cuids, the format @default(cuid()) actually produces. */
const PROJECT_ID = 'cmea1x4k80000ab12cd34ef56';
const FILE_ID = 'cmea1x4k80001ab12gh78ij90';

describe('doc ids', () => {
  it('round-trips a project and file id', () => {
    const docId = makeDocId(PROJECT_ID, FILE_ID);

    expect(docId).toBe(`${PROJECT_ID}:${FILE_ID}`);
    expect(parseDocId(docId)).toEqual({ projectId: PROJECT_ID, fileId: FILE_ID });
  });

  it('accepts the whole id charset', () => {
    expect(parseDocId('A-b_1:C-d_2')).toEqual({ projectId: 'A-b_1', fileId: 'C-d_2' });
  });

  it('accepts both halves at their maximum length', () => {
    const part = 'a'.repeat(MAX_DOC_ID_PART_LENGTH);
    expect(parseDocId(`${part}:${part}`)).toEqual({ projectId: part, fileId: part });
  });
});

/**
 * Every one of these must return null rather than throw: module 3.2's upgrade
 * handler branches on the value to pick a close code.
 */
const INVALID: Array<[string, string]> = [
  ['empty', ''],
  ['no separator', 'abc'],
  ['two separators', 'a:b:c'],
  ['missing project id', ':b'],
  ['missing file id', 'a:'],
  ['bare separator', ':'],
  ['double separator', '::'],
  ['over-long half', `${'a'.repeat(MAX_DOC_ID_PART_LENGTH + 1)}:b`],
  ['space inside a half', 'a b:c'],
  ['trailing space in a half', 'a :b'],
  ['newline', 'a\n:b'],
  ['slash', 'a/b:c'],
  ['dot', 'a.b:c'],
  ['NUL byte', 'a\0:b'],
  ['unicode', 'ä:b'],
];

describe('parseDocId rejections', () => {
  it.each(INVALID)('rejects %s', (_label, docId) => {
    expect(parseDocId(docId)).toBeNull();
  });

  it('never throws, whatever it is given', () => {
    for (const [, docId] of INVALID) {
      expect(() => parseDocId(docId)).not.toThrow();
    }
  });
});

/**
 * These values are hard-coded on both sides of the wire in modules 3.2–3.5.
 * Changing one is a protocol change, and this is the test that says so out loud.
 */
describe('protocol constants', () => {
  it('pins the endpoint and document shape', () => {
    expect(WS_PATH).toBe('/ws');
    expect(WS_DOC_PARAM).toBe('doc');
    expect(Y_TEXT_KEY).toBe('content');
    expect(DOC_ID_SEPARATOR).toBe(':');
  });

  it('pins the message type tags', () => {
    expect(MessageType.Sync).toBe(0);
    expect(MessageType.Awareness).toBe(1);
  });

  it('pins the close codes, each with a reason', () => {
    expect(CloseCode).toEqual({
      BadRequest: 4400,
      Unauthenticated: 4401,
      Forbidden: 4403,
      NotFound: 4404,
      Gone: 4409,
    });

    for (const code of Object.values(CloseCode)) {
      expect(closeReason(code).length).toBeGreaterThan(0);
    }
  });
});
