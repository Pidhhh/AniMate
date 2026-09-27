/* The reply protocol.
 *
 * Ported from `js/api.js` (`parseTaggedReply`, `parseTagFields`,
 * `extractState`). A reply may open with a machine tag naming how the
 * character should look:
 *
 *     [emotion:happy|attitude:agree] Well, hello there.
 *
 * The tag is consumed and never displayed. Everything after it is the spoken
 * line. The game-layer `<state>` block the original also parsed is *stripped*
 * here rather than interpreted — bond, quests and inventory are out of scope
 * (see the plan), but a model that emits one must not have it read aloud.
 */

export const EMOTIONS = [
  'neutral',
  'happy',
  'laughing',
  'tease',
  'shy',
  'cuddle',
  'sad',
  'crying',
  'angry',
] as const;

export const ATTITUDES = ['agree', 'deny', 'question'] as const;

export type EmotionName = (typeof EMOTIONS)[number];
export type AttitudeName = (typeof ATTITUDES)[number];

export interface ParsedReply {
  /** Null when the model said nothing about it — the caller keeps the
   *  previous value rather than snapping back to neutral. */
  emotion: EmotionName | null;
  attitude: AttitudeName | null;
  /** The spoken line, with all machine content removed. */
  text: string;
}

/** Values meaning "unchanged". Kept so a model echoing the tag back does not
 *  reset the expression. */
const KEEP = new Set(['keep', 'same', 'omit', 'here']);

const MACHINE_KEY =
  /(?:^|[|｜,\s])(?:emotion|attitude|undress|nsfw|stage|place|tod|sleep|time_advance)\s*[:：]/i;

function isMachineTag(tag: string): boolean {
  return MACHINE_KEY.test('|' + tag);
}

function isEmotion(value: string): value is EmotionName {
  return (EMOTIONS as readonly string[]).includes(value);
}

function isAttitude(value: string): value is AttitudeName {
  return (ATTITUDES as readonly string[]).includes(value);
}

/** Reads `key:value` pairs out of one tag.
 *
 *  Split on pipes only. Replacing `|` with spaces and splitting on whitespace
 *  would break `emotion: shy` by making the value its own token — the original
 *  carries a note about exactly that. */
function applyTagFields(tag: string, out: ParsedReply): void {
  for (const part of String(tag || '').split(/[|｜,]/)) {
    const match = /^\s*([A-Za-z_]+)\s*[:：]\s*(\S+)/.exec(part);
    if (!match) continue;

    const key = (match[1] ?? '').toLowerCase();
    const raw = (match[2] ?? '').toLowerCase();
    if (KEEP.has(raw)) continue;

    if (key === 'emotion' && isEmotion(raw)) out.emotion = raw;
    else if (key === 'attitude' && isAttitude(raw)) out.attitude = raw;
  }
}

/** Removes a trailing `<state>` block.
 *
 *  Not interpreted — the game layer is out of scope — but it must not reach
 *  the transcript or the speaker. The closing tag is optional because models
 *  routinely forget it, in which case the block runs to the end. */
function stripStateBlock(body: string): string {
  const closed = /<state>\s*[\s\S]*?\s*<\/state>/i.exec(body);
  if (closed) {
    return (body.slice(0, closed.index) + body.slice(closed.index + closed[0].length)).trim();
  }
  const open = /<state>\s*[\s\S]*$/i.exec(body);
  if (open) return body.slice(0, open.index).trim();
  return body;
}

/**
 * Split a raw model reply into a machine tag and a spoken line.
 *
 * Tolerant by design: the endpoints this talks to are whatever the user
 * configured, and they vary in how much they decorate a response. Thinking
 * blocks, code fences and a BOM are all stripped rather than shown.
 */
export function parseReply(raw: string): ParsedReply {
  const out: ParsedReply = { emotion: null, attitude: null, text: '' };

  let body = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .trim();

  body = body
    .replace(/^```[\w-]*\s*\n?/, '')
    .replace(/\n```\s*$/, '')
    .trim();
  body = body.replace(/^<think\b[^>]*>[\s\S]*?<\/think>\s*/i, '');
  body = body.replace(/^<reasoning\b[^>]*>[\s\S]*?<\/reasoning>\s*/i, '');

  /* Leading tags, consumed while they are genuinely machine tags.
   *
   * `isMachineTag` is the real gate — the loop can only continue while it sees
   * something that names a known key. The counter is only an infinite-loop
   * backstop, and it is deliberately generous: the original used three, which
   * left a visible `[attitude:deny]` stranded in the transcript whenever a
   * model emitted four tags in a row. */
  let guard = 0;
  while (guard++ < 8 && body.startsWith('[')) {
    const end = body.indexOf(']');
    if (end === -1) break;
    const tag = body.slice(1, end);
    if (!isMachineTag(tag)) break;
    applyTagFields(tag, out);
    body = body.slice(end + 1).replace(/^\s+/, '');
  }

  body = stripStateBlock(body);

  /* A tag left unterminated by a truncated stream is dropped rather than
     spoken aloud. */
  if (/^\[[^\]]*$/.test(body)) body = '';

  out.text = body.trim();
  return out;
}

/* ------------------------------------------------------------------ fallback */

interface Heuristic {
  emotion: EmotionName;
  test: RegExp;
}

/* Order matters: the first match wins, so the more specific patterns come
   first. Deliberately conservative — a wrong guess is more jarring than no
   guess, and `null` leaves the current expression alone. */
const HEURISTICS: Heuristic[] = [
  { emotion: 'laughing', test: /(haha|hehe|hahaha|\blol\b|😂|🤣)/i },
  { emotion: 'crying', test: /(sob|sobbing|\bT_T\b|😭)/i },
  { emotion: 'sad', test: /\b(sorry|apolog|unfortunate|sadly|regret)\b/i },
  { emotion: 'angry', test: /\b(angry|furious|annoyed|how dare|stop that)\b/i },
  { emotion: 'shy', test: /\b(blush|embarrass|shy|don't look|flustered)\b/i },
  { emotion: 'tease', test: /\b(teasing|you wish|as if|obviously|silly)\b/i },
  { emotion: 'happy', test: /(!|😊|😄|\b(great|wonderful|delight|glad|yay)\b)/i },
];

/**
 * Best-effort emotion when the model emitted no tag.
 *
 * Only used as a fallback. The tag is the real channel: it is explicit and the
 * model can express something the words do not carry.
 */
export function guessEmotion(text: string): EmotionName | null {
  for (const { emotion, test } of HEURISTICS) {
    if (test.test(text)) return emotion;
  }
  return null;
}

/** Resolve the emotion to apply, preferring an explicit tag. */
export function resolveEmotion(parsed: ParsedReply): EmotionName | null {
  return parsed.emotion ?? guessEmotion(parsed.text);
}

/* ------------------------------------------------------------- self-check */

interface Case {
  name: string;
  input: string;
  emotion?: EmotionName | null;
  attitude?: AttitudeName | null;
  text?: string;
}

const CASES: Case[] = [
  {
    name: 'tag is consumed and not shown',
    input: '[emotion:happy|attitude:agree] Oh, hello!',
    emotion: 'happy',
    attitude: 'agree',
    text: 'Oh, hello!',
  },
  {
    name: 'no tag leaves emotion unset',
    input: 'Just a plain reply.',
    emotion: null,
    text: 'Just a plain reply.',
  },
  {
    name: 'unknown emotion is ignored, not defaulted',
    input: '[emotion:ecstatic] Hmm.',
    emotion: null,
    text: 'Hmm.',
  },
  {
    name: 'keep means unchanged',
    input: '[emotion:keep] Still here.',
    emotion: null,
    text: 'Still here.',
  },
  {
    name: 'thinking block is stripped',
    input: '<think>weighing options</think>[emotion:shy] I suppose so.',
    emotion: 'shy',
    text: 'I suppose so.',
  },
  {
    name: 'code fence is stripped',
    input: '```text\n[emotion:tease] You wish.\n```',
    emotion: 'tease',
    text: 'You wish.',
  },
  {
    name: 'state block is removed, not spoken',
    input: '[emotion:happy] All done.<state>{"bond":3}</state>',
    emotion: 'happy',
    text: 'All done.',
  },
  {
    name: 'unterminated tag is dropped',
    input: '[emotion:hap',
    emotion: null,
    text: '',
  },
  {
    name: 'bom is stripped',
    input: '\uFEFF[emotion:sad] Oh no.',
    emotion: 'sad',
    text: 'Oh no.',
  },
  {
    name: 'spaced value survives the split',
    input: '[emotion: shy | attitude: question] Really?',
    emotion: 'shy',
    attitude: 'question',
    text: 'Really?',
  },
  {
    name: 'state without a closing tag still goes',
    input: '[emotion:cuddle] Come here.<state>{"bond":9}',
    emotion: 'cuddle',
    text: 'Come here.',
  },
];

/** Run the parser against known inputs.
 *
 *  Dev-only. The parser is a pure function with a lot of branches and no UI of
 *  its own — exactly the kind of code that rots quietly. Running a handful of
 *  cases at boot puts the result in the app log, where it can actually be
 *  seen, without wiring a test framework up for eleven assertions. */
export function runProtocolSelfTest(): { passed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;

  for (const testCase of CASES) {
    const got = parseReply(testCase.input);
    const problems: string[] = [];

    if (testCase.emotion !== undefined && got.emotion !== testCase.emotion) {
      problems.push(`emotion ${JSON.stringify(got.emotion)} != ${JSON.stringify(testCase.emotion)}`);
    }
    if (testCase.attitude !== undefined && got.attitude !== testCase.attitude) {
      problems.push(
        `attitude ${JSON.stringify(got.attitude)} != ${JSON.stringify(testCase.attitude)}`,
      );
    }
    if (testCase.text !== undefined && got.text !== testCase.text) {
      problems.push(`text ${JSON.stringify(got.text)} != ${JSON.stringify(testCase.text)}`);
    }

    if (problems.length) failures.push(`${testCase.name}: ${problems.join('; ')}`);
    else passed += 1;
  }

  return { passed, failures };
}
