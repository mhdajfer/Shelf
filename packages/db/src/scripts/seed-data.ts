import type { Category } from '@shelf/shared';

export interface SeedPrompt {
  title: string;
  description: string;
  category: Category;
  modelHint: string;
  tags: string[];
  body: string;
}

export interface SeedAuthor {
  handle: string;
  name: string;
  email: string;
}

export const SEED_AUTHORS: SeedAuthor[] = [
  { handle: 'rmorrow', name: 'Rae Morrow', email: 'rae@example.test' },
  { handle: 'kbasu', name: 'Kiran Basu', email: 'kiran@example.test' },
  { handle: 'tveld', name: 'Tomas Veld', email: 'tomas@example.test' },
  { handle: 'ishibata', name: 'Ines Shibata', email: 'ines@example.test' },
  { handle: 'dokonkwo', name: 'Dayo Okonkwo', email: 'dayo@example.test' },
  { handle: 'mlindqvist', name: 'Mira Lindqvist', email: 'mira@example.test' },
];

export const SEED_PROMPTS: SeedPrompt[] = [
  {
    title: 'Tighten a paragraph without losing the argument',
    description:
      'Cuts filler and hedging while keeping every claim. Reports what it removed so you can put anything back.',
    category: 'writing',
    modelHint: 'any',
    tags: ['editing', 'concision'],
    body: `Tighten the paragraph below. Keep every claim and the order they appear in.

Rules:
- Remove hedges, filler, and repeated setup.
- Do not introduce facts that are not already present.
- Keep the author's register; do not make it more formal.

Return the tightened paragraph, then a short list of what you cut and why.

Paragraph:
{{text}}`,
  },
  {
    title: 'Turn meeting notes into a decision log',
    description:
      'Separates decisions from discussion. Anything without an owner or a date is listed as unresolved rather than invented.',
    category: 'writing',
    modelHint: 'Claude',
    tags: ['meetings', 'notes'],
    body: `Read the notes and produce a decision log.

For each decision: what was decided, who owns it, by when, and what it rules out.
If the notes do not state an owner or a date, write "not stated" — do not guess.

End with two sections: "Open questions" and "Discussed, not decided".

Notes:
{{notes}}`,
  },
  {
    title: 'Rewrite for a skeptical reader',
    description:
      'Takes a draft and a specific objection, then rewrites so the objection is answered in the text instead of in a footnote.',
    category: 'writing',
    modelHint: 'any',
    tags: ['editing', 'persuasion'],
    body: `A reader will object: "{{objection}}"

Rewrite the draft so that objection is addressed where it would naturally arise, not appended at the end. Do not add new evidence; use what is already there, and say plainly where the draft is weak.

Draft:
{{draft}}`,
  },
  {
    title: 'Headline variants with different angles',
    description:
      'Produces headlines that differ in angle rather than wording, each labelled with the angle it takes.',
    category: 'writing',
    modelHint: 'GPT',
    tags: ['headlines', 'copy'],
    body: `Write {{count:8}} headlines for the topic below.

Each must take a different angle, not a different phrasing of the same angle. Label each with its angle in brackets, for example [consequence], [contrast], [specific number], [question].

No colons. No "how to" unless it is genuinely the strongest option.

Topic:
{{topic}}`,
  },
  {
    title: 'Plain-language rewrite at a fixed reading level',
    description:
      'Rewrites to a target grade level and lists any term it could not simplify without changing the meaning.',
    category: 'writing',
    modelHint: 'any',
    tags: ['accessibility', 'editing'],
    body: `Rewrite the text for a grade {{grade:8}} reading level.

Keep all technical terms that carry meaning, but define each on first use in one clause. Shorten sentences; do not drop content.

Afterwards, list any term you could not simplify and explain what would have been lost.

Text:
{{text}}`,
  },
  {
    title: 'Cut word count by a target percentage',
    description:
      'Hits a length target and shows the before and after counts so you can check it actually did.',
    category: 'writing',
    modelHint: 'any',
    tags: ['editing', 'concision'],
    body: `Cut the text below by {{percent:25}} percent.

State the original and final word counts. Preserve the structure and every distinct point; cut within sentences before cutting whole ones. If you cannot reach the target without losing a point, stop at the point where the next cut would, and say so.

Text:
{{text}}`,
  },

  {
    title: 'Explain this stack trace and name the likely cause',
    description:
      'Reads a trace and ranks candidate causes by likelihood, with the specific line that supports each.',
    category: 'coding',
    modelHint: 'Claude',
    tags: ['debugging', 'errors'],
    body: `Language or runtime: {{language}}

Read the stack trace and explain, in order:
1. What the program was doing when it failed.
2. The frame where the problem most likely originates, and why that frame rather than the top one.
3. Two or three candidate causes, ranked, each citing the line of the trace that supports it.
4. The smallest check that would distinguish between them.

Trace:
{{trace}}`,
  },
  {
    title: 'Review a diff for correctness, not style',
    description:
      'A review pass that ignores formatting and naming and looks only for behaviour that is wrong.',
    category: 'coding',
    modelHint: 'Claude',
    tags: ['code-review', 'correctness'],
    body: `Review this diff for correctness only. Ignore formatting, naming, and anything a linter would catch.

For each finding, give: the file and line, the input or state that triggers it, and the wrong result. If you are unsure whether something is a bug, say so and give the check that would settle it.

If you find nothing, say so plainly rather than inventing a nitpick.

Diff:
{{diff}}`,
  },
  {
    title: 'Write table-driven tests for a function',
    description:
      'Generates a case table covering boundaries and error paths, not just the happy path.',
    category: 'coding',
    modelHint: 'any',
    tags: ['testing', 'coverage'],
    body: `Write table-driven tests for the function below using {{framework:vitest}}.

Cover: the ordinary case, every boundary, empty and single-element inputs, and each error path the code can actually reach. Name each case by the behaviour it pins, not by its inputs.

Do not test private helpers through the public function twice.

Code:
{{code}}`,
  },
  {
    title: 'Translate a SQL query to an ORM call',
    description:
      'Converts raw SQL and flags any part that the ORM cannot express without an escape hatch.',
    category: 'coding',
    modelHint: 'any',
    tags: ['sql', 'orm'],
    body: `Target ORM: {{orm:Drizzle}}

Translate the query below. Keep the same result set and the same ordering.

Call out any clause the ORM cannot express directly, and show the raw-SQL escape hatch for just that clause rather than falling back to raw SQL for the whole query.

Query:
{{sql}}`,
  },
  {
    title: 'Draft a migration plan for a schema change',
    description:
      'Produces an ordered, reversible plan with the deploy boundary marked, for a change that cannot be done in one step.',
    category: 'coding',
    modelHint: 'Claude',
    tags: ['database', 'migrations'],
    body: `Current schema:
{{current}}

Target schema:
{{target}}

Produce a migration plan that never leaves the database in a state the running code cannot read. Number the steps, mark where a deploy has to happen between them, and give the rollback for each. Note any step that locks a table and roughly for how long.`,
  },
  {
    title: 'Name things consistently in a module',
    description:
      'Finds naming that disagrees with itself across a file and proposes one scheme, with the rename list.',
    category: 'coding',
    modelHint: 'any',
    tags: ['refactoring', 'naming'],
    body: `Read the module and find places where naming disagrees with itself: the same concept under two names, the same name for two concepts, or a verb form that does not match what the function does.

Propose one scheme and give the rename list as old to new. Do not rename anything that is part of a public API without flagging it separately.

Module:
{{code}}`,
  },
  {
    title: 'Turn a bug report into a failing test case',
    description:
      'Converts a vague report into the smallest reproduction, and lists what the report does not tell you.',
    category: 'coding',
    modelHint: 'any',
    tags: ['testing', 'debugging'],
    body: `Turn this report into the smallest test that would fail today.

State the setup, the action, and the assertion. Then list what the report leaves unstated that you had to assume, so the reporter can confirm or correct it.

Report:
{{report}}`,
  },

  {
    title: 'Extract claims and the evidence offered for each',
    description:
      'Separates what a source asserts from what it supports, and marks the claims carried by nothing.',
    category: 'research',
    modelHint: 'Claude',
    tags: ['analysis', 'evidence'],
    body: `Read the source and build a table: claim, evidence offered, type of evidence (data, citation, anecdote, assertion), and strength.

Mark every claim with no evidence behind it. Do not supply evidence from your own knowledge — the question is what this source offers.

Source:
{{source}}`,
  },
  {
    title: 'Steelman the opposing position',
    description:
      'Argues the other side at its strongest, then names the one thing that would actually change your mind.',
    category: 'research',
    modelHint: 'Claude',
    tags: ['reasoning', 'argument'],
    body: `Position I hold: {{position}}

Argue the strongest version of the opposing case. Use the best evidence available to it, not the weakest. Do not caricature.

Then state: the single piece of evidence that would most move me, and the question on which the disagreement actually turns.`,
  },
  {
    title: 'Compare two sources and surface where they disagree',
    description:
      'Maps agreement, disagreement, and the places where the two are answering different questions.',
    category: 'research',
    modelHint: 'any',
    tags: ['analysis', 'comparison'],
    body: `Source A:
{{a}}

Source B:
{{b}}

Produce three sections: where they agree, where they genuinely disagree, and where they appear to disagree but are answering different questions.

For each disagreement, say what kind it is: different data, different definitions, or different values.`,
  },
  {
    title: 'Build a reading order for an unfamiliar field',
    description:
      'A sequence sized to the time you have, where each item is justified by what it unlocks next.',
    category: 'research',
    modelHint: 'any',
    tags: ['learning', 'reading'],
    body: `Field: {{field}}
Time available: {{hours:10}} hours

Give a reading order. For each item: what it is, roughly how long, and what it makes the next item possible to understand. Prefer one good primary source over three summaries.

If the time is not enough to get a real footing, say what the honest goal is instead.`,
  },
  {
    title: 'Interview guide from a research question',
    description:
      'Turns a question into non-leading interview questions, ordered so early answers do not bias later ones.',
    category: 'research',
    modelHint: 'GPT',
    tags: ['user-research', 'interviews'],
    body: `Research question: {{question}}
Participants: {{participants}}

Write an interview guide. Questions must be about past behaviour, not hypotheticals or preferences. Order them so an early answer does not prime a later one. Mark where to probe and what to probe for.

Flag any question that is leading and give the neutral version.`,
  },
  {
    title: 'Summarize a paper for someone outside the field',
    description:
      'Explains the result, the method, and the limits without the jargon, and keeps the uncertainty intact.',
    category: 'research',
    modelHint: 'Claude',
    tags: ['summarizing', 'papers'],
    body: `Audience: {{audience}}

Summarize the paper in four parts: the question, what they did, what they found, and what it does not show.

Keep the uncertainty the authors report — do not firm up a tentative result. Define each technical term once, in a clause.

Paper:
{{paper}}`,
  },

  {
    title: 'Rewrite a feature list as outcomes',
    description:
      'Converts features into what the reader can now do, and drops the ones that do not survive the translation.',
    category: 'marketing',
    modelHint: 'any',
    tags: ['copy', 'positioning'],
    body: `Rewrite each feature below as the thing the reader can now do that they could not before.

If a feature does not survive that translation, say so rather than padding it. Keep the list the same length or shorter.

No adjectives that cannot be checked.

Features:
{{features}}`,
  },
  {
    title: 'Positioning statement from a competitor comparison',
    description:
      'Finds the one axis where you genuinely differ and writes the statement around it.',
    category: 'marketing',
    modelHint: 'Claude',
    tags: ['positioning', 'strategy'],
    body: `Product: {{product}}
Competitor: {{competitor}}

Identify the axes on which these two actually differ, discard the ones customers do not choose on, and name the single strongest remaining one.

Write a positioning statement around it that the competitor could not honestly also claim. Then state who this positioning gives up.`,
  },
  {
    title: 'Cold email that earns a reply',
    description: 'A short email with a specific reason for writing to this person, and one ask.',
    category: 'marketing',
    modelHint: 'GPT',
    tags: ['email', 'outreach'],
    body: `Context: {{context}}
The ask: {{ask}}

Write a cold email under 120 words. It must contain a specific reason for writing to this person rather than anyone else, and exactly one ask that takes under two minutes to answer.

No flattery. No "I hope this finds you well". No paragraph about your company before the reason.`,
  },
  {
    title: 'Landing page section outline',
    description:
      'An outline where each section earns its place by answering the next question a reader has.',
    category: 'marketing',
    modelHint: 'any',
    tags: ['landing-page', 'structure'],
    body: `Product: {{product}}
Audience: {{audience}}

Outline the page section by section. For each: the question in the reader's head at that point, what the section must prove, and the evidence it uses.

Cut any section that does not answer a question the previous one raised.`,
  },
  {
    title: 'Turn a changelog into release notes for customers',
    description:
      'Rewrites internal commits as user-visible changes, and drops what nobody outside can observe.',
    category: 'marketing',
    modelHint: 'any',
    tags: ['release-notes', 'changelog'],
    body: `Rewrite the changelog as release notes for customers.

Group by what the reader can now do. Drop anything with no observable effect outside the codebase. Keep breaking changes at the top with the migration step.

Do not describe internals. Do not use "various improvements".

Changelog:
{{changelog}}`,
  },
  {
    title: 'Objection handling script',
    description: 'Answers an objection by conceding the true part first, then arguing the rest.',
    category: 'marketing',
    modelHint: 'Claude',
    tags: ['sales', 'objections'],
    body: `Product: {{product}}
Objection: {{objection}}

Write a response that opens by conceding whatever is true in the objection, then addresses the rest. If the objection is simply correct for this buyer, say that and name who the product is for instead.

Keep it to what a person would actually say out loud.`,
  },

  {
    title: 'Describe a dataset before analysing it',
    description:
      'Forces a pass over shape, nulls, and suspect columns before any conclusion gets drawn.',
    category: 'data',
    modelHint: 'any',
    tags: ['eda', 'data-quality'],
    body: `Schema:
{{schema}}

Row count: {{rows}}

Before any analysis, write what you would check: which columns can be null and what null means for each, which are categorical with an unbounded set, which dates could be in two timezones, and which pairs are likely to be duplicated.

List the three checks most likely to invalidate a naive analysis.`,
  },
  {
    title: 'Write a SQL query from a question in prose',
    description:
      'Produces the query plus the assumption it had to make, so you can check the assumption.',
    category: 'data',
    modelHint: 'any',
    tags: ['sql', 'analysis'],
    body: `Schema:
{{schema}}

Question: {{question}}

Write the query. Then state every assumption you had to make to write it — about joins, null handling, time boundaries, and deduplication — as a short list.

If the question is ambiguous in a way that changes the answer, give the two queries and say what distinguishes them.`,
  },
  {
    title: 'Sanity-check an analysis for confounds',
    description: 'Looks for the explanation you did not consider before the result gets presented.',
    category: 'data',
    modelHint: 'Claude',
    tags: ['statistics', 'review'],
    body: `Read the analysis and look for what else could produce this result: selection in how the data was collected, a variable that moves with both, a time effect, or survivorship.

For each, say what it would look like in the data and the check that would rule it out.

Analysis:
{{analysis}}`,
  },
  {
    title: 'Choose a chart for a comparison',
    description: 'Recommends one chart and says what it hides, rather than listing every option.',
    category: 'data',
    modelHint: 'any',
    tags: ['visualization', 'charts'],
    body: `Comparison: {{comparison}}
Audience: {{audience}}

Recommend one chart type. Say what it makes easy to see, what it hides, and the specific way a reader is likely to misread it.

Then give the axis, sort order, and labelling decisions that matter most for this particular comparison.`,
  },
  {
    title: 'Explain a metric definition precisely',
    description:
      'Writes a definition tight enough that two analysts would compute the same number.',
    category: 'data',
    modelHint: 'any',
    tags: ['metrics', 'definitions'],
    body: `Metric: {{metric}}

Write a definition precise enough that two analysts would get the same number. Specify the population, the time window and its boundaries, what is excluded, and how late-arriving data is handled.

Then give one worked example and one edge case where a looser definition would diverge.`,
  },
  {
    title: 'Draft a dbt model description',
    description: 'Documents what a model is for, its grain, and what it should not be used for.',
    category: 'data',
    modelHint: 'any',
    tags: ['dbt', 'documentation'],
    body: `Model:
{{model}}

Write the description: what question it answers, its grain (one row per what), its refresh cadence, and the upstream sources it depends on.

End with "Do not use this for", listing the questions it looks like it answers but does not.`,
  },

  {
    title: 'Explain a concept three ways at increasing depth',
    description:
      'A one-sentence version, a worked version, and the version with the caveats, so you can stop where you need to.',
    category: 'learning',
    modelHint: 'any',
    tags: ['explaining', 'concepts'],
    body: `Concept: {{concept}}

Explain it three times:
1. One sentence, no analogies.
2. A worked example with concrete numbers or code.
3. The version with the caveats and the cases where the simple picture breaks.

Each pass must correct something the previous one simplified. Say explicitly what it was.`,
  },
  {
    title: 'Generate practice problems with worked solutions',
    description:
      'Problems that get harder for a stated reason, each with the mistake it is designed to catch.',
    category: 'learning',
    modelHint: 'GPT',
    tags: ['practice', 'exercises'],
    body: `Topic: {{topic}}

Write {{count:5}} practice problems in increasing difficulty. For each: the problem, the worked solution, and the specific misconception it catches.

Say what makes each harder than the last. Do not increase difficulty by adding arithmetic.`,
  },
  {
    title: 'Find the gap in my explanation',
    description:
      'Reads your explanation back and finds the step you skipped because you already knew it.',
    category: 'learning',
    modelHint: 'Claude',
    tags: ['feedback', 'teaching'],
    body: `Topic: {{topic}}

Below is my explanation. Read it as someone who does not already know the topic.

Find: the step I skipped, the term I used before defining, and the point where a reasonable person would form the wrong model. Quote the exact sentence for each.

Do not rewrite it. Just show me the gaps.

My explanation:
{{explanation}}`,
  },
  {
    title: 'Spaced repetition cards from notes',
    description: 'Makes cards that test recall rather than recognition, one fact each.',
    category: 'learning',
    modelHint: 'any',
    tags: ['flashcards', 'memory'],
    body: `Turn these notes into spaced repetition cards.

Rules:
- One fact per card.
- The front must be answerable without the back visible, and must not contain the answer.
- No yes/no questions. No cards that test recognition instead of recall.
- Skip anything that is context rather than a fact worth memorising.

Notes:
{{notes}}`,
  },
  {
    title: 'Socratic walkthrough of a problem',
    description: 'Asks one question at a time and waits, instead of explaining the whole thing.',
    category: 'learning',
    modelHint: 'Claude',
    tags: ['tutoring', 'questions'],
    body: `Problem: {{problem}}

Walk me to the answer by asking one question at a time. Wait for my reply before the next. Do not give the answer, and do not ask a question whose phrasing contains it.

If I go wrong, ask the question that reveals it rather than correcting me.`,
  },

  {
    title: 'Weekly review prompts from a task list',
    description: 'Turns a list into the three questions worth asking about it this week.',
    category: 'productivity',
    modelHint: 'any',
    tags: ['review', 'planning'],
    body: `Here is my task list:
{{tasks}}

Ask me the three questions most worth answering about this list right now. Base them on what the list shows: what has been carried over repeatedly, what has no next action, and what is large enough that it is probably hiding a decision.

Do not reorganise the list. Do not add tasks.`,
  },
  {
    title: 'Break a vague goal into a first action',
    description:
      'Finds the smallest thing you could do today, and the decision that is actually blocking it.',
    category: 'productivity',
    modelHint: 'any',
    tags: ['planning', 'goals'],
    body: `Goal: {{goal}}

Identify the decision that is actually blocking this, as opposed to the work. Then give the smallest concrete action that would either make that decision or prove it does not matter.

The action must be doable in under 30 minutes and must not be "research" or "think about".`,
  },
  {
    title: 'Draft an agenda that could end early',
    description:
      'An agenda with a stated purpose per item, built so the meeting can finish when the purpose is met.',
    category: 'productivity',
    modelHint: 'any',
    tags: ['meetings', 'agenda'],
    body: `Purpose: {{purpose}}
Length: {{minutes:30}} minutes

Write an agenda. For each item: the question it answers, who needs to be there for it, and how we know it is done.

Order it so the meeting can end as soon as the purpose is met. Mark anything that does not need this meeting at all.`,
  },
  {
    title: 'Write a handover doc for time off',
    description:
      'Covers what could go wrong while you are away and who decides, not just what you do.',
    category: 'productivity',
    modelHint: 'Claude',
    tags: ['handover', 'documentation'],
    body: `My responsibilities:
{{responsibilities}}

Away for {{days:5}} days.

Write the handover. For each area: the state it is in now, what is likely to come up, who decides in my absence, and what should simply wait for me.

Include the things that only I currently know. End with what to escalate and to whom.`,
  },
  {
    title: 'Say no without burning the relationship',
    description:
      'Declines clearly, gives the real reason, and offers the nearest thing you can do.',
    category: 'productivity',
    modelHint: 'any',
    tags: ['communication', 'boundaries'],
    body: `Request: {{request}}
My actual reason for declining: {{reason}}

Write the reply. Decline in the first two sentences — no long preamble. Give a real reason without over-explaining or apologising more than once.

Offer the nearest thing I can genuinely do, or say plainly that there is nothing. Do not invent a constraint.`,
  },
];

/** Public prompts that guests contributed, shown with a guest handle. */
export const SEED_GUEST_PROMPTS: SeedPrompt[] = [
  {
    title: 'Name a function from its body',
    description: 'For when the logic is right and the name is wrong.',
    category: 'coding',
    modelHint: 'any',
    tags: ['naming', 'refactoring'],
    body: `Suggest three names for this function based only on what it does.

For each, say what it implies about the function that might not be true. Then pick one and say why.

{{code}}`,
  },
  {
    title: 'Rewrite a commit message',
    description: 'Imperative subject, body that explains why rather than what.',
    category: 'coding',
    modelHint: 'any',
    tags: ['git', 'commits'],
    body: `Rewrite this as a commit message.

Subject: imperative, under 72 characters, no trailing period.
Body: why the change was needed and what it rules out. Do not restate the diff.

{{change}}`,
  },
  {
    title: 'Turn a question into a search query',
    description: 'Converts a prose question into terms a search index would actually match.',
    category: 'research',
    modelHint: 'any',
    tags: ['search', 'queries'],
    body: `Question: {{question}}

Give three search queries: one narrow, one broad, and one using the vocabulary a specialist would use rather than a layperson. Say what each is likely to over-return.`,
  },
];
