import { describe, expect, it } from 'vitest';
import {
  EMOTIONS,
  guessEmotion,
  parseReply,
  resolveEmotion,
  runProtocolSelfTest,
} from './protocol';

/* The parser is a pure function with a lot of branches and no UI of its own —
   exactly the kind of code that rots quietly. These cases are the same ones
   `runProtocolSelfTest` runs at boot, plus the edges that only a real test
   runner can express. */

describe('parseReply — machine tags', () => {
  it('consumes a leading tag and keeps the spoken line', () => {
    const r = parseReply('[emotion:happy|attitude:agree] Oh, hello!');
    expect(r.emotion).toBe('happy');
    expect(r.attitude).toBe('agree');
    expect(r.text).toBe('Oh, hello!');
  });

  it('accepts full-width pipes and colons', () => {
    /* Models trained on Japanese text emit these, and a half-width-only
       regex silently leaves the tag in the transcript. */
    const r = parseReply('[emotion：tease｜attitude：agree] Oh really?');
    expect(r.emotion).toBe('tease');
    expect(r.attitude).toBe('agree');
    expect(r.text).toBe('Oh really?');
  });

  it('keeps a spaced value intact', () => {
    /* Splitting on whitespace instead of pipes makes `shy` its own token and
       drops it. The original carries a note about exactly this. */
    const r = parseReply('[emotion: shy | attitude: question] Really?');
    expect(r.emotion).toBe('shy');
    expect(r.attitude).toBe('question');
    expect(r.text).toBe('Really?');
  });

  it('leaves the emotion unset when there is no tag', () => {
    /* Null, not 'neutral'. A default would snap the character to neutral on
       every reply that forgot a tag. */
    const r = parseReply('Just a plain reply.');
    expect(r.emotion).toBeNull();
    expect(r.text).toBe('Just a plain reply.');
  });

  it('ignores an emotion outside the vocabulary', () => {
    const r = parseReply('[emotion:ecstatic] Hmm.');
    expect(r.emotion).toBeNull();
    expect(r.text).toBe('Hmm.');
  });

  it('treats "keep" as unchanged rather than as a value', () => {
    const r = parseReply('[emotion:keep] Still here.');
    expect(r.emotion).toBeNull();
    expect(r.text).toBe('Still here.');
  });

  it('does not treat prose in brackets as a tag', () => {
    const r = parseReply('[aside] this is prose');
    expect(r.text).toBe('[aside] this is prose');
    expect(r.emotion).toBeNull();
  });

  it('consumes a chain of tags without leaking any of them', () => {
    /* A model that emits several tags in a row must not leave the tail of the
       chain sitting in the transcript. */
    const r = parseReply(
      '[emotion:happy][attitude:agree][emotion:sad][attitude:deny] real text',
    );
    expect(r.text).toBe('real text');
  });
});

describe('parseReply — decoration', () => {
  it('strips a thinking block', () => {
    const r = parseReply('<think>weighing options</think>[emotion:shy] I suppose so.');
    expect(r.emotion).toBe('shy');
    expect(r.text).toBe('I suppose so.');
  });

  it('strips a reasoning block', () => {
    const r = parseReply('<reasoning>hm</reasoning>[emotion:sad] Oh no.');
    expect(r.emotion).toBe('sad');
    expect(r.text).toBe('Oh no.');
  });

  it('strips a code fence', () => {
    const r = parseReply('```text\n[emotion:tease] You wish.\n```');
    expect(r.emotion).toBe('tease');
    expect(r.text).toBe('You wish.');
  });

  it('strips a BOM', () => {
    const r = parseReply('\uFEFF[emotion:sad] Oh no.');
    expect(r.emotion).toBe('sad');
    expect(r.text).toBe('Oh no.');
  });
});

describe('parseReply — the state block', () => {
  /* The game layer is out of scope, but a model that emits a state block must
     not have it read aloud or shown. */

  it('removes a closed state block', () => {
    const r = parseReply('[emotion:happy] All done.<state>{"bond":3}</state>');
    expect(r.emotion).toBe('happy');
    expect(r.text).toBe('All done.');
  });

  it('removes an unterminated state block', () => {
    const r = parseReply('[emotion:cuddle] Come here.<state>{"bond":9}');
    expect(r.emotion).toBe('cuddle');
    expect(r.text).toBe('Come here.');
  });
});

describe('parseReply — truncation', () => {
  it('drops an unterminated tag rather than speaking it', () => {
    /* A stream cut mid-tag would otherwise be displayed verbatim and read
       aloud letter by letter. */
    const r = parseReply('[emotion:hap');
    expect(r.emotion).toBeNull();
    expect(r.text).toBe('');
  });

  it('survives empty and nullish input', () => {
    expect(parseReply('').text).toBe('');
    expect(parseReply(undefined as unknown as string).text).toBe('');
    expect(parseReply(null as unknown as string).text).toBe('');
  });
});

describe('guessEmotion', () => {
  it('reads laughter', () => {
    expect(guessEmotion('hahaha that is great')).toBe('laughing');
  });

  it('reads sadness before happiness', () => {
    /* Order matters — `sorry!` contains an exclamation mark, and the happy
       pattern would otherwise win. */
    expect(guessEmotion('I am sorry!')).toBe('sad');
  });

  it('returns null when nothing matches', () => {
    /* Null leaves the current expression alone, which is better than a wrong
       guess. */
    expect(guessEmotion('The meeting is at four.')).toBeNull();
  });

  it('never returns a value outside the vocabulary', () => {
    for (const text of ['haha', 'sorry', 'blush', 'yay!', 'T_T', 'how dare you']) {
      const guess = guessEmotion(text);
      if (guess !== null) expect(EMOTIONS).toContain(guess);
    }
  });
});

describe('resolveEmotion', () => {
  it('prefers the explicit tag over the heuristic', () => {
    /* The tag is the real channel: the model can name something the words do
       not carry. */
    const r = parseReply('[emotion:shy] hahaha');
    expect(resolveEmotion(r)).toBe('shy');
  });

  it('falls back to the heuristic when there is no tag', () => {
    const r = parseReply('hahaha');
    expect(resolveEmotion(r)).toBe('laughing');
  });

  it('returns null when neither channel says anything', () => {
    expect(resolveEmotion(parseReply('The meeting is at four.'))).toBeNull();
  });
});

describe('runProtocolSelfTest', () => {
  it('passes in full', () => {
    /* This runs at boot in the built app, where vitest does not exist. If it
       ever fails here, the in-app smoke check is lying. */
    const { passed, failures } = runProtocolSelfTest();
    expect(failures).toEqual([]);
    expect(passed).toBeGreaterThan(0);
  });
});
