'use client';

import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return <DynamicCodeBlock code={code} lang={lang} />;
}
