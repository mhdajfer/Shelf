import type { Metadata } from 'next';
import Link from 'next/link';

import { CopyButton } from '@/components/copy-button';
import { McpSetup } from '@/components/mcp-setup';
import { MCP_URL, routes } from '@/lib/routes';

export const metadata: Metadata = {
  title: 'Connect an MCP client',
  description:
    'Use the prompts on your Shelf as slash commands in Claude Code, Codex CLI, Gemini CLI, Cursor, and VS Code.',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-6">
      <h2 className="font-medium">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The setup guide for every MCP client. Public: it is where a new user lands
 * from the README, the MCP Registry listing, or the metadata documents'
 * `service_documentation`.
 */
export default function McpDocsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-8">
      <div className="flex flex-col gap-2">
        <h1 className="font-mono text-2xl tracking-tight">Connect an MCP client</h1>
        <p className="text-text-muted">
          Shelf is a remote{' '}
          <a href="https://modelcontextprotocol.io" className="text-accent underline">
            Model Context Protocol
          </a>{' '}
          server. Connect a client once and every prompt on your shelf becomes a command in it, with
          its <code className="font-mono">{'{{variables}}'}</code> as arguments. The client’s model
          can also search your shelf and the public library, and save new prompts for you.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2.5">
        <span className="text-sm text-text-muted">Server URL</span>
        <code className="min-w-0 flex-1 font-mono text-sm break-all">{MCP_URL}</code>
        <CopyButton text={MCP_URL} size="sm" label="Copy server URL" />
      </div>

      <McpSetup />

      <Section title="What you approve">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
          <li>
            Signing in opens Shelf in your browser. You choose whether the app may also save
            prompts, and whether it sees all your prompts, only pinned ones, or one collection.
          </li>
          <li>
            Anything an app saves is private. No app can publish, vote, or delete through Shelf.
          </li>
          <li>
            Prompts from the public library reach the app labelled as written by someone else, so
            its model treats them as text rather than as your instructions.
          </li>
          <li>
            Every app you approved is listed in{' '}
            <Link href={routes.settings} className="text-accent underline">
              Settings → Connected apps
            </Link>
            , where you can disconnect it. Resetting your password disconnects them all.
          </li>
        </ul>
      </Section>

      <Section title="If it does not connect">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
          <li>
            Signing in needs a browser on the machine running the client. Over SSH or in CI, use an
            access token instead; each tab shows how.
          </li>
          <li>
            If the client says it is unauthorized after working before, it was disconnected or
            unused for 30 days. Sign in again from the client.
          </li>
          <li>
            The consent page shows the name the app gives itself. If you did not just start
            connecting an app, deny the request.
          </li>
        </ul>
      </Section>
    </main>
  );
}
