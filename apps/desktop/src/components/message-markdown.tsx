import { isTauri } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import {
  Button,
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from '@workspace/ui/components';
import { DownloadIcon, WrapTextIcon } from 'lucide-react';
import { Children, isValidElement, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { toast } from 'sonner';

import { useHighlightedCode } from '@/hooks/use-highlighted-code';

import 'katex/dist/katex.min.css';

function MessageCodeBlock({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const lines = useHighlightedCode(code, language);
  const [wrap, setWrap] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const { t } = useTranslation();
  const download = async () => {
    setDownloading(true);
    const extensions: Record<string, string> = {
      javascript: 'js',
      typescript: 'ts',
      python: 'py',
      bash: 'sh',
      shell: 'sh',
      shellscript: 'sh',
      markdown: 'md',
      yaml: 'yml',
      text: 'txt',
    };
    const extension =
      extensions[language] ??
      (/^[a-z0-9]+$/i.test(language) ? language : 'txt');
    const filename = `code.${extension}`;
    try {
      if (isTauri()) {
        const path = await save({ defaultPath: filename });
        if (path) await writeTextFile(path, code);
      } else {
        const url = URL.createObjectURL(
          new Blob([code], { type: 'text/plain;charset=utf-8' }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        // Keep the URL alive until the browser has started the download.
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      toast.error(t('codeBlock.downloadFailed'), {
        description: String(error),
      });
    } finally {
      setDownloading(false);
    }
  };
  return (
    <CodeBlock className='border-0'>
      <CodeBlockHeader>
        <CodeBlockTitle>{language || 'text'}</CodeBlockTitle>
        <CodeBlockActions>
          <Button
            variant='ghost'
            size='icon-xs'
            aria-label={t('codeBlock.wrap')}
            title={t('codeBlock.wrap')}
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
          >
            <WrapTextIcon />
          </Button>
          <Button
            variant='ghost'
            size='icon-xs'
            aria-label={t('codeBlock.download')}
            title={t('codeBlock.download')}
            disabled={downloading}
            onClick={() => void download()}
          >
            <DownloadIcon />
          </Button>
          <CodeBlockCopyButton value={code} title={t('codeBlock.copy')} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers wrap={wrap}>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

const components: Components = {
  a: ({ node: _node, ...props }) => (
    <a
      {...props}
      className='text-primary underline underline-offset-3'
      target='_blank'
      rel='noreferrer'
    />
  ),
  blockquote: ({ children }) => (
    <blockquote className='text-muted-foreground border-border border-l-2 pl-3'>
      {children}
    </blockquote>
  ),
  code: ({ children }) => (
    <code className='bg-muted rounded px-1 py-0.5 font-mono text-[0.9em]'>
      {children}
    </code>
  ),
  // Handle fences at the pre boundary so unlabelled and unfinished fences
  // receive the same controls without nesting pre elements.
  pre: ({ children }) => {
    const child = Children.toArray(children)[0];
    if (!isValidElement<{ children?: ReactNode; className?: string }>(child))
      return <pre>{children}</pre>;
    const code = Children.toArray(child.props.children)
      .map((part) =>
        typeof part === 'string' || typeof part === 'number'
          ? String(part)
          : '',
      )
      .join('')
      .replace(/\n$/, '');
    const language =
      child.props.className?.match(/language-([^\s]+)/)?.[1] ?? '';
    return <MessageCodeBlock code={code} language={language} />;
  },
  h1: ({ children }) => <h1 className='text-xl font-semibold'>{children}</h1>,
  h2: ({ children }) => <h2 className='text-lg font-semibold'>{children}</h2>,
  h3: ({ children }) => <h3 className='text-base font-semibold'>{children}</h3>,
  p: ({ children }) => (
    <p className='leading-6 whitespace-pre-wrap'>{children}</p>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className='list-decimal pl-5'>
      {children}
    </ol>
  ),
  ul: ({ children }) => <ul className='list-disc pl-5'>{children}</ul>,
  li: ({ children }) => (
    <li className='leading-6 [&:has(>input)]:list-none'>{children}</li>
  ),
  table: ({ children }) => (
    <div className='max-w-full overflow-x-auto'>
      <table className='w-full border-collapse text-sm'>{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className='border-border bg-muted border px-3 py-2 text-start font-semibold'
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className='border-border border px-3 py-2'>
      {children}
    </td>
  ),
  img: ({ node: _node, ...props }) => (
    <img {...props} loading='lazy' className='h-auto max-w-full rounded-md' />
  ),
};

/** Shared by workflow output and the main agent, including partial streamed Markdown. */
export function MessageMarkdown({ content }: { content: string }) {
  return (
    <div className='flex max-w-full min-w-0 flex-col gap-3 wrap-anywhere [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto'>
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  );
}
