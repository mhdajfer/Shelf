import { describe, expect, it } from 'vitest';

import { extractVariables, parseTemplate } from './parse.js';
import type { TemplateDiagnosticCode } from './types.js';

const names = (source: string): string[] => extractVariables(source).map((v) => v.name);
const codes = (source: string): TemplateDiagnosticCode[] =>
  parseTemplate(source).diagnostics.map((d) => d.code);

describe('parseTemplate', () => {
  it('returns nothing for an empty body', () => {
    expect(parseTemplate('')).toEqual({ tokens: [], variables: [], diagnostics: [] });
  });

  it('treats a body with no placeholders as one text token', () => {
    const { tokens, variables } = parseTemplate('Summarize the article.');
    expect(tokens).toEqual([{ kind: 'text', start: 0, end: 22, value: 'Summarize the article.' }]);
    expect(variables).toEqual([]);
  });

  it('parses a bare variable', () => {
    const { tokens, variables, diagnostics } = parseTemplate('{{name}}');
    expect(tokens).toEqual([
      {
        kind: 'variable',
        start: 0,
        end: 8,
        name: 'name',
        defaultValue: undefined,
        raw: '{{name}}',
      },
    ]);
    expect(variables).toEqual([
      { name: 'name', defaultValue: undefined, occurrences: 1, firstIndex: 0 },
    ]);
    expect(diagnostics).toEqual([]);
  });

  it('splits text around variables with exact offsets', () => {
    const { tokens } = parseTemplate('Hi {{name}}!');
    expect(tokens).toEqual([
      { kind: 'text', start: 0, end: 3, value: 'Hi ' },
      {
        kind: 'variable',
        start: 3,
        end: 11,
        name: 'name',
        defaultValue: undefined,
        raw: '{{name}}',
      },
      { kind: 'text', start: 11, end: 12, value: '!' },
    ]);
  });

  it('handles adjacent variables', () => {
    const { tokens } = parseTemplate('{{a}}{{b}}');
    expect(tokens.map((t) => [t.start, t.end])).toEqual([
      [0, 5],
      [5, 10],
    ]);
    expect(names('{{a}}{{b}}')).toEqual(['a', 'b']);
  });

  describe('defaults', () => {
    it('reads a default value', () => {
      expect(extractVariables('{{tone:friendly}}')[0]?.defaultValue).toBe('friendly');
    });

    it('splits on the first colon only', () => {
      expect(extractVariables('{{url:https://example.com:8080/path}}')[0]?.defaultValue).toBe(
        'https://example.com:8080/path',
      );
    });

    it('distinguishes an empty default from no default', () => {
      expect(extractVariables('{{name:}}')[0]?.defaultValue).toBe('');
      expect(extractVariables('{{name}}')[0]?.defaultValue).toBeUndefined();
    });

    it('trims whitespace around the name and the default', () => {
      const [variable] = extractVariables('{{  tone  :  calm and direct  }}');
      expect(variable?.name).toBe('tone');
      expect(variable?.defaultValue).toBe('calm and direct');
    });

    it('keeps whitespace inside a default', () => {
      expect(extractVariables('{{q:what is  this}}')[0]?.defaultValue).toBe('what is  this');
    });
  });

  describe('duplicates', () => {
    it('collapses repeats into one variable and counts occurrences', () => {
      const [variable, ...rest] = extractVariables('{{topic}} and more about {{topic}}');
      expect(rest).toEqual([]);
      expect(variable?.occurrences).toBe(2);
      expect(variable?.firstIndex).toBe(0);
    });

    it('adopts a default declared by a later occurrence', () => {
      const parsed = parseTemplate('{{topic}} then {{topic:ravens}}');
      expect(parsed.variables[0]?.defaultValue).toBe('ravens');
      expect(parsed.diagnostics).toEqual([]);
    });

    it('keeps the first default and reports a conflicting one', () => {
      const parsed = parseTemplate('{{topic:ravens}} then {{topic:crows}}');
      expect(parsed.variables[0]?.defaultValue).toBe('ravens');
      expect(parsed.diagnostics).toHaveLength(1);
      expect(parsed.diagnostics[0]?.code).toBe('conflicting-default');
      expect(parsed.diagnostics[0]?.start).toBe(22);
    });

    it('does not report a repeated identical default', () => {
      expect(codes('{{topic:ravens}} {{topic:ravens}}')).toEqual([]);
    });

    it('treats names as case sensitive', () => {
      expect(names('{{Topic}} {{topic}}')).toEqual(['Topic', 'topic']);
    });
  });

  describe('invalid tags', () => {
    it('reports an unclosed tag and leaves the text alone', () => {
      const parsed = parseTemplate('Hello {{name');
      expect(parsed.variables).toEqual([]);
      expect(parsed.diagnostics).toEqual([
        {
          code: 'unclosed-tag',
          message: 'This placeholder is missing its closing }}.',
          start: 6,
          end: 12,
        },
      ]);
      expect(parsed.tokens).toEqual([{ kind: 'text', start: 0, end: 12, value: 'Hello {{name' }]);
    });

    it('keeps variables parsed before an unclosed tag', () => {
      const parsed = parseTemplate('{{a}} {{b');
      expect(parsed.variables.map((v) => v.name)).toEqual(['a']);
      expect(parsed.diagnostics.map((d) => d.code)).toEqual(['unclosed-tag']);
    });

    it.each([
      ['{{first name}}', 'a space'],
      ['{{1st}}', 'a leading digit'],
      ['{{user.name}}', 'a dot'],
      ['{{naïve}}', 'a non-ascii letter'],
      ['{{a b:c}}', 'a space before the default'],
    ])('rejects %s (%s)', (source) => {
      const parsed = parseTemplate(source);
      expect(parsed.variables).toEqual([]);
      expect(parsed.diagnostics.map((d) => d.code)).toEqual(['invalid-name']);
    });

    it.each(['{{under_score}}', '{{kebab-case}}', '{{_leading}}', '{{a1}}'])(
      'accepts %s',
      (source) => {
        expect(parseTemplate(source).variables).toHaveLength(1);
      },
    );

    it.each(['{{}}', '{{ }}', '{{:default}}'])('reports %s as an empty name', (source) => {
      expect(codes(source)).toEqual(['empty-name']);
    });

    it('rejects an over-long name', () => {
      expect(codes(`{{${'a'.repeat(65)}}}`)).toEqual(['invalid-name']);
      expect(codes(`{{${'a'.repeat(64)}}}`)).toEqual([]);
    });

    it('does not parse nested braces as a variable', () => {
      const source = '{{a{{b}}}}';
      const parsed = parseTemplate(source);
      expect(parsed.variables).toEqual([]);
      expect(parsed.diagnostics.map((d) => d.code)).toEqual(['invalid-name']);
      expect(parsed.tokens).toEqual([{ kind: 'text', start: 0, end: 10, value: source }]);
    });

    it('reports exceeding the variable cap once, without dropping variables', () => {
      const source = '{{a}}{{b}}{{c}}{{a}}';
      const parsed = parseTemplate(source, { maxVariables: 2 });
      expect(parsed.diagnostics.map((d) => d.code)).toEqual(['too-many-variables']);
      expect(parsed.variables.map((v) => v.name)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('escapes', () => {
    it('treats \\{{ as a literal opening brace pair', () => {
      const parsed = parseTemplate('\\{{name}}');
      expect(parsed.variables).toEqual([]);
      expect(parsed.tokens).toEqual([{ kind: 'text', start: 0, end: 9, value: '{{name}}' }]);
    });

    it('also accepts an escaped closing pair', () => {
      const parsed = parseTemplate('\\{{name\\}}');
      expect(parsed.variables).toEqual([]);
      expect(parsed.tokens[0]).toMatchObject({ value: '{{name}}' });
    });

    it('treats \\\\ as a literal backslash before a real variable', () => {
      const parsed = parseTemplate('\\\\{{name}}');
      expect(parsed.variables.map((v) => v.name)).toEqual(['name']);
      expect(parsed.tokens[0]).toEqual({ kind: 'text', start: 0, end: 2, value: '\\' });
    });

    it('leaves an unrelated backslash alone', () => {
      expect(parseTemplate('a\\b').tokens[0]).toMatchObject({ value: 'a\\b' });
    });
  });

  describe('whitespace and line endings', () => {
    it('preserves newlines and carriage returns', () => {
      const source = 'Line one\r\n\r\n{{body}}\n\nEnd';
      const parsed = parseTemplate(source);
      expect(parsed.variables.map((v) => v.name)).toEqual(['body']);
      expect(parsed.tokens[0]).toMatchObject({ value: 'Line one\r\n\r\n' });
      expect(parsed.tokens[2]).toMatchObject({ value: '\n\nEnd' });
    });
  });

  describe('token offsets', () => {
    const samples = [
      '',
      'plain',
      '{{a}}',
      'Hi {{name}}!',
      '{{a}}{{b}}',
      '{{a:1}} x {{a:2}}',
      'Hello {{name',
      '{{a{{b}}}}',
      '\\{{escaped}} and {{real}}',
      '\\\\{{real}}',
      '{{ }}',
      'multi\nline {{v}} body\r\n',
    ];

    it.each(samples)('reconstructs the source exactly for %j', (source) => {
      const { tokens } = parseTemplate(source);
      expect(tokens.map((t) => source.slice(t.start, t.end)).join('')).toBe(source);
    });

    it.each(samples)('emits contiguous, ordered ranges for %j', (source) => {
      const { tokens } = parseTemplate(source);
      let cursor = 0;
      for (const token of tokens) {
        expect(token.start).toBe(cursor);
        expect(token.end).toBeGreaterThan(token.start);
        cursor = token.end;
      }
      expect(cursor).toBe(source.length);
    });
  });
});
