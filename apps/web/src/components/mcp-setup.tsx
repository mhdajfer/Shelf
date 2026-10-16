'use client';

import type { ReactNode } from 'react';

import { CopyButton } from '@/components/copy-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MCP_URL } from '@/lib/routes';

/** A command or file to copy, with its own copy button. */
function Snippet({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-text-muted">{label}</span>
        <CopyButton text={children} size="sm" label={`Copy: ${label}`} />
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-surface-sunken px-3 py-2.5 font-mono text-[0.8125rem] leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm marker:text-text-subtle">
      {children}
    </ol>
  );
}

function Step({ children }: { children: ReactNode }) {
  return <li className="flex flex-col gap-2 pl-1">{children}</li>;
}

function WithToken({ children }: { children: ReactNode }) {
  return (
    <details className="rounded-md border border-border px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">
        No browser where it runs? Use an access token
      </summary>
      <div className="flex flex-col gap-3 pt-3">
        <p className="text-text-muted">
          Create one in Settings → Access tokens. Keep it out of anything you commit: the examples
          read it from the <code className="font-mono">SHELF_TOKEN</code> environment variable where
          the client allows it.
        </p>
        {children}
      </div>
    </details>
  );
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/**
 * One tab per client. Each was checked against that client's documentation
 * when written; clients rename their settings between releases, so the
 * endpoint and the sign-in flow are the parts that stay true.
 */
export function McpSetup() {
  return (
    <Tabs defaultValue="claude-code">
      <TabsList aria-label="MCP client">
        <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
        <TabsTrigger value="codex">Codex CLI</TabsTrigger>
        <TabsTrigger value="gemini">Gemini CLI</TabsTrigger>
        <TabsTrigger value="cursor">Cursor</TabsTrigger>
        <TabsTrigger value="vscode">VS Code</TabsTrigger>
      </TabsList>

      <TabsContent value="claude-code">
        <Steps>
          <Step>
            <p>Add Shelf. User scope makes it available in every project.</p>
            <Snippet label="Terminal">
              {`claude mcp add --transport http --scope user shelf ${MCP_URL}`}
            </Snippet>
          </Step>
          <Step>
            <p>
              In Claude Code, run <code className="font-mono">/mcp</code>, choose{' '}
              <span className="font-medium">shelf</span>, then{' '}
              <span className="font-medium">Authenticate</span>. Your browser opens Shelf; approve
              the connection and return to the terminal.
            </p>
          </Step>
          <Step>
            <p>
              Each prompt is now a command: <code className="font-mono">/mcp__shelf__</code>{' '}
              followed by its command name, which its page shows you. Its{' '}
              <code className="font-mono">{'{{variables}}'}</code> are the arguments, in order. You
              can also ask Claude to find a prompt on your shelf, or to save one.
            </p>
          </Step>
        </Steps>
        <WithToken>
          <Snippet label="Terminal">
            {`claude mcp add --transport http --scope user shelf ${MCP_URL} \\\n  --header "Authorization: Bearer $SHELF_TOKEN"`}
          </Snippet>
          <p className="text-text-muted">
            Or, for a team, commit a <code className="font-mono">.mcp.json</code> that reads each
            person’s own token from their environment:
          </p>
          <Snippet label=".mcp.json">
            {json({
              mcpServers: {
                shelf: {
                  type: 'http',
                  url: MCP_URL,
                  headers: { Authorization: 'Bearer ${SHELF_TOKEN}' },
                },
              },
            })}
          </Snippet>
        </WithToken>
      </TabsContent>

      <TabsContent value="codex">
        <Steps>
          <Step>
            <p>Add Shelf, then sign in. Codex opens your browser to approve it.</p>
            <Snippet label="Terminal">
              {`codex mcp add shelf --url ${MCP_URL}\ncodex mcp login shelf`}
            </Snippet>
          </Step>
          <Step>
            <p>
              In a session, <code className="font-mono">/mcp</code> lists Shelf’s tools.
            </p>
          </Step>
        </Steps>
        <WithToken>
          <Snippet label="~/.codex/config.toml">
            {`[mcp_servers.shelf]\nurl = "${MCP_URL}"\nbearer_token_env_var = "SHELF_TOKEN"`}
          </Snippet>
        </WithToken>
      </TabsContent>

      <TabsContent value="gemini">
        <Steps>
          <Step>
            <p>Add Shelf.</p>
            <Snippet label="Terminal">{`gemini mcp add --transport http shelf ${MCP_URL}`}</Snippet>
          </Step>
          <Step>
            <p>
              In Gemini CLI, run <code className="font-mono">/mcp auth shelf</code>. Your browser
              opens Shelf; approve the connection.
            </p>
          </Step>
        </Steps>
        <WithToken>
          <p className="text-text-muted">With a header set, Gemini CLI does not try to sign in.</p>
          <Snippet label="Terminal">
            {`gemini mcp add --transport http --header "Authorization: Bearer $SHELF_TOKEN" shelf ${MCP_URL}`}
          </Snippet>
        </WithToken>
      </TabsContent>

      <TabsContent value="cursor">
        <Steps>
          <Step>
            <p>
              Add Shelf to <code className="font-mono">~/.cursor/mcp.json</code> for every project,
              or to <code className="font-mono">.cursor/mcp.json</code> for one.
            </p>
            <Snippet label="mcp.json">{json({ mcpServers: { shelf: { url: MCP_URL } } })}</Snippet>
          </Step>
          <Step>
            <p>
              Cursor shows Shelf as needing sign-in. Start it from Cursor’s MCP settings; your
              browser opens Shelf to approve the connection.
            </p>
          </Step>
        </Steps>
        <WithToken>
          <Snippet label="mcp.json">
            {json({
              mcpServers: {
                shelf: {
                  url: MCP_URL,
                  headers: { Authorization: 'Bearer ${env:SHELF_TOKEN}' },
                },
              },
            })}
          </Snippet>
        </WithToken>
      </TabsContent>

      <TabsContent value="vscode">
        <Steps>
          <Step>
            <p>
              Add Shelf to <code className="font-mono">.vscode/mcp.json</code>, or to your user
              configuration with <span className="font-medium">MCP: Open User Configuration</span>.
            </p>
            <Snippet label="mcp.json">
              {json({ servers: { shelf: { type: 'http', url: MCP_URL } } })}
            </Snippet>
          </Step>
          <Step>
            <p>
              Start the server. On the first connection VS Code opens your browser to approve it.
            </p>
          </Step>
        </Steps>
        <WithToken>
          <p className="text-text-muted">
            VS Code asks for the token once and keeps it in its secret storage.
          </p>
          <Snippet label="mcp.json">
            {json({
              inputs: [
                {
                  type: 'promptString',
                  id: 'shelf-token',
                  description: 'Shelf access token',
                  password: true,
                },
              ],
              servers: {
                shelf: {
                  type: 'http',
                  url: MCP_URL,
                  headers: { Authorization: 'Bearer ${input:shelf-token}' },
                },
              },
            })}
          </Snippet>
        </WithToken>
      </TabsContent>
    </Tabs>
  );
}
