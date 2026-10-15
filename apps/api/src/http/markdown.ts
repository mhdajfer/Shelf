import type { PromptSummary } from '@shelf/db';
import { CATEGORY_LABELS, type Category } from '@shelf/shared';

/** A fence longer than any run of backticks in the body, so the body cannot close it. */
function fenceFor(body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** One prompt as a self-contained Markdown document: `GET /prompts/:id/export` and the MCP resource. */
export function toMarkdown(prompt: PromptSummary): string {
  const fence = fenceFor(prompt.body);
  const lines = [
    `# ${prompt.title}`,
    '',
    ...(prompt.description === null ? [] : [prompt.description, '']),
    `- Category: ${CATEGORY_LABELS[prompt.category as Category] ?? prompt.category}`,
    ...(prompt.tags.length === 0 ? [] : [`- Tags: ${prompt.tags.join(', ')}`]),
    ...(prompt.modelHint === null ? [] : [`- Written for: ${prompt.modelHint}`]),
    `- Author: ${prompt.author.handle}`,
    `- Version: ${String(prompt.versionNumber)}`,
    ...(prompt.variables.length === 0
      ? []
      : [`- Variables: ${prompt.variables.map((variable) => variable.name).join(', ')}`]),
    '',
    `${fence}text`,
    prompt.body,
    fence,
    '',
  ];
  return lines.join('\n');
}
