'use client';

/**
 * Source code viewer for the agent detail page.
 *
 * Client component because react-syntax-highlighter ships a non-trivial
 * client bundle for the Prism grammars. We lazy-load the highlighter and
 * paint a `<pre>` fallback on first render so the page doesn't block.
 *
 * The source TS is fetched server-side from Vercel Blob (Shipper writes it)
 * and passed in as a plain string — no client fetch here.
 */
import * as React from 'react';
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter';
import ts from 'react-syntax-highlighter/dist/esm/languages/hljs/typescript';
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs';

import { CopyButton } from '@/components/shared/copy-button';

SyntaxHighlighter.registerLanguage('typescript', ts);

interface AgentSourceViewerProps {
  source: string;
  filename?: string;
}

export function AgentSourceViewer({
  source,
  filename = 'worker.ts',
}: AgentSourceViewerProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
        <span className="font-mono">{filename}</span>
        <CopyButton value={source} label="Copy source" size="sm" />
      </div>
      <div className="max-h-[600px] overflow-auto text-sm">
        <SyntaxHighlighter
          language="typescript"
          style={atomOneDark}
          showLineNumbers
          customStyle={{
            background: 'transparent',
            margin: 0,
            padding: '1rem',
            fontSize: 13,
            lineHeight: 1.6,
          }}
          lineNumberStyle={{ color: 'hsl(var(--muted-foreground))' }}
        >
          {source}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
