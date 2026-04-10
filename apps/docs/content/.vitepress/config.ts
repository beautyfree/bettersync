import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'better-sync',
  description: 'Tiny local-first sync for TypeScript',
  themeConfig: {
    nav: [
      { text: 'Docs', link: '/docs/' },
      { text: 'GitHub', link: 'https://github.com/beautyfree/bettersync' },
      { text: 'npm', link: 'https://www.npmjs.com/package/better-sync' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Introduction', link: '/docs/' },
          { text: 'Getting Started', link: '/docs/getting-started' },
          { text: 'Core Concepts', link: '/docs/concepts' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Adapters', link: '/docs/adapters' },
          { text: 'Integrations', link: '/docs/integrations' },
          { text: 'React', link: '/docs/react' },
          { text: 'CLI', link: '/docs/cli' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/beautyfree/bettersync' },
    ],
  },
})
