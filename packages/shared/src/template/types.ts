export interface TemplateVariable {
  name: string;
  /** Present when any occurrence declared one with `{{name:default}}`. */
  defaultValue?: string;
  occurrences: number;
  /** Source offset of the first `{{` for this variable. */
  firstIndex: number;
}

export type TemplateDiagnosticCode =
  'unclosed-tag' | 'empty-name' | 'invalid-name' | 'conflicting-default' | 'too-many-variables';

export interface TemplateDiagnostic {
  code: TemplateDiagnosticCode;
  /** Shown to the author verbatim, so it is written as a sentence. */
  message: string;
  start: number;
  end: number;
}

export type TemplateToken =
  | { kind: 'text'; start: number; end: number; value: string }
  | {
      kind: 'variable';
      start: number;
      end: number;
      name: string;
      defaultValue?: string;
      /** Original `{{...}}` source, used when rendering leaves a variable unfilled. */
      raw: string;
    };

export interface ParsedTemplate {
  /** Covers the whole source in order; text tokens carry unescaped values. */
  tokens: TemplateToken[];
  /** Distinct variables, in order of first appearance. */
  variables: TemplateVariable[];
  diagnostics: TemplateDiagnostic[];
}

export type TemplateValues = Record<string, string | undefined>;
