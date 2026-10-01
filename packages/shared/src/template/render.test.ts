import { describe, expect, it } from 'vitest';

import { parseTemplate } from './parse.js';
import { initialValues, missingVariables, renderTemplate } from './render.js';

describe('renderTemplate', () => {
  it('substitutes supplied values', () => {
    expect(
      renderTemplate('Hi {{name}}, write about {{topic}}.', { name: 'Ada', topic: 'looms' }),
    ).toBe('Hi Ada, write about looms.');
  });

  it('substitutes every occurrence', () => {
    expect(renderTemplate('{{x}}-{{x}}-{{x}}', { x: 'a' })).toBe('a-a-a');
  });

  it('falls back to the declared default', () => {
    expect(renderTemplate('Tone: {{tone:direct}}')).toBe('Tone: direct');
  });

  it('applies a default declared on a later occurrence to every occurrence', () => {
    expect(renderTemplate('{{tone}} / {{tone:direct}}')).toBe('direct / direct');
  });

  it('lets a supplied empty string override the default', () => {
    expect(renderTemplate('[{{tone:direct}}]', { tone: '' })).toBe('[]');
  });

  it('ignores an undefined value and uses the default', () => {
    expect(renderTemplate('[{{tone:direct}}]', { tone: undefined })).toBe('[direct]');
  });

  it('keeps unfilled placeholders visible by default', () => {
    expect(renderTemplate('Hi {{name}}!')).toBe('Hi {{name}}!');
  });

  it('drops unfilled placeholders when asked', () => {
    expect(renderTemplate('Hi {{name}}!', {}, { onMissing: 'empty' })).toBe('Hi !');
  });

  it('unescapes braces in the output', () => {
    expect(renderTemplate('Literal \\{{name\\}} and {{name}}', { name: 'Ada' })).toBe(
      'Literal {{name}} and Ada',
    );
  });

  it('leaves an invalid tag in place verbatim', () => {
    expect(renderTemplate('{{first name}} {{ok}}', { ok: 'yes' })).toBe('{{first name}} yes');
  });

  it('does not re-expand a value that itself looks like a placeholder', () => {
    expect(renderTemplate('{{a}}', { a: '{{b}}', b: 'nope' })).toBe('{{b}}');
  });

  it('ignores values for variables the body does not declare', () => {
    expect(renderTemplate('{{a}}', { a: '1', unused: '2' })).toBe('1');
  });
});

describe('missingVariables', () => {
  it('lists only variables with no value and no default', () => {
    const parsed = parseTemplate('{{a}} {{b:x}} {{c}}');
    expect(missingVariables(parsed, { a: 'filled' })).toEqual(['c']);
  });

  it('is empty when everything resolves', () => {
    expect(missingVariables(parseTemplate('{{a:1}}'))).toEqual([]);
  });
});

describe('initialValues', () => {
  it('prefills defaults and leaves the rest empty', () => {
    expect(initialValues(parseTemplate('{{a}} {{b:hello}}'))).toEqual({ a: '', b: 'hello' });
  });

  it('produces one entry per distinct variable', () => {
    expect(initialValues(parseTemplate('{{a}}{{a}}{{b}}'))).toEqual({ a: '', b: '' });
  });
});
