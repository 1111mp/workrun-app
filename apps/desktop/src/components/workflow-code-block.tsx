import { useEffect, useState } from 'react';
import {
  bundledLanguages,
  codeToTokens,
  type BundledLanguage,
} from 'shiki/bundle/web';

type HighlightedToken = {
  content: string;
  color?: string;
};

type WorkflowCodeBlockProps = {
  className?: string;
  code: string;
};

function languageFromClassName(className?: string) {
  const language = className?.match(/language-([^\s]+)/)?.[1].toLowerCase();
  if (language && language in bundledLanguages) {
    return language as BundledLanguage;
  }

  return 'text';
}

function WorkflowCodeBlock({ className, code }: WorkflowCodeBlockProps) {
  const language = languageFromClassName(className);
  const [tokens, setTokens] = useState<HighlightedToken[][]>();

  useEffect(() => {
    let cancelled = false;
    setTokens(undefined);
    const timer = window.setTimeout(() => {
      void codeToTokens(code, {
        lang: language,
        theme: 'github-dark',
      })
        .then((result) => {
          if (!cancelled) setTokens(result.tokens);
        })
        .catch(() => {
          if (!cancelled) setTokens(undefined);
        });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, language]);

  if (!tokens) {
    return <code className={className}>{code}</code>;
  }

  return (
    <code className={className}>
      {tokens.map((line, lineIndex) => (
        <span key={lineIndex}>
          {line.map((token, tokenIndex) => (
            <span key={tokenIndex} style={{ color: token.color }}>
              {token.content}
            </span>
          ))}
          {lineIndex < tokens.length - 1 ? '\n' : ''}
        </span>
      ))}
    </code>
  );
}

export { WorkflowCodeBlock };
