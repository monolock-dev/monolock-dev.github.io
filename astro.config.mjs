// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';

// https://astro.build/config
export default defineConfig({
	site: 'https://monolock-dev.github.io',
	integrations: [
		mermaid({
			autoTheme: true,
		}),
		starlight({
			title: 'monolock',
			description:
				'A lightweight TCP server for named locks — a distributed mutex without the distributed system.',
			logo: {
				light: './src/assets/monolock.png',
				dark: './src/assets/monolock-dark.png',
				replacesTitle: true,
			},
			favicon: '/favicon.svg',
			customCss: ['./src/styles/docs.css'],
			components: {
				Header: './src/components/docs/Header.astro',
				ThemeProvider: './src/components/docs/ThemeProvider.astro',
				ThemeSelect: './src/components/docs/ThemeSelect.astro',
			},
			head: [
				{
					tag: 'link',
					attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
				},
				{
					tag: 'link',
					attrs: {
						rel: 'preconnect',
						href: 'https://fonts.gstatic.com',
						crossorigin: true,
					},
				},
				{
					tag: 'link',
					attrs: {
						rel: 'stylesheet',
						href: 'https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500;700&family=Martian+Mono:wght@400;500&display=swap',
					},
				},
			],
			expressiveCode: {
				themes: [
					{
						name: 'monolock',
						type: 'dark',
						colors: {
							'editor.background': '#191715',
							'editor.foreground': '#d8d3cc',
						},
						tokenColors: [
							{
								scope: ['comment', 'punctuation.definition.comment'],
								settings: { foreground: '#5c564f' },
							},
							{
								scope: ['string', 'punctuation.definition.string'],
								settings: { foreground: '#8fb3a8' },
							},
							{
								scope: [
									'constant.numeric',
									'constant.language',
									'constant.other',
								],
								settings: { foreground: '#e5c07b' },
							},
							{
								scope: ['keyword', 'storage.type', 'storage.modifier'],
								settings: { foreground: '#6d6660' },
							},
							{
								scope: ['entity.name.function', 'support.function'],
								settings: { foreground: '#f4f1ec' },
							},
							{
								scope: ['variable', 'entity.name'],
								settings: { foreground: '#d8d3cc' },
							},
						],
					},
				],
				styleOverrides: {
					borderColor: '#2e2b28',
					borderRadius: '10px',
					codeFontSize: '0.8125rem',
					frames: {
						editorTabBarBackground: '#151412',
						editorActiveTabBackground: '#191715',
						editorActiveTabIndicatorTopColor: '#f0b429',
						terminalTitlebarBackground: '#151412',
						terminalTitlebarBorderBottomColor: '#211f1d',
						terminalBackground: '#191715',
					},
				},
			},
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/monolock-dev/monolock',
				},
			],
			editLink: {
				baseUrl:
					'https://github.com/monolock-dev/monolock-dev.github.io/edit/main/',
			},
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Introduction', slug: 'start/introduction' },
						{ label: 'Quick start', slug: 'start/quickstart' },
					],
				},
				{
					label: 'Concepts',
					items: [
						{ label: 'How it works', slug: 'concepts/how-it-works' },
						{ label: 'Fencing tokens', slug: 'concepts/fencing-tokens' },
						{ label: 'Capacity & limits', slug: 'concepts/capacity' },
					],
				},
				{
					label: 'Comparisons',
					items: [
						{ label: 'vs Redis & Redlock', slug: 'comparisons/redis' },
						{
							label: 'vs Postgres advisory locks',
							slug: 'comparisons/postgres-advisory-locks',
						},
						{ label: 'vs etcd', slug: 'comparisons/etcd' },
					],
				},
				{
					label: 'Operations',
					items: [
						{ label: 'Configuration', slug: 'operations/configuration' },
						{ label: 'TLS & mTLS', slug: 'operations/tls' },
						{ label: 'ACL authorization', slug: 'operations/acl' },
						{ label: 'Audit log', slug: 'operations/audit' },
						{ label: 'Admin API', slug: 'operations/admin-api' },
						{ label: 'Observability', slug: 'operations/observability' },
						{ label: 'Deployment', slug: 'operations/deployment' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Wire protocol', slug: 'reference/protocol' },
						{ label: 'Error codes', slug: 'reference/errors' },
					],
				},
				{
					label: 'Clients',
					items: [
						{ label: 'Go', slug: 'clients/go' },
						{ label: 'Writing a client', slug: 'clients/writing-a-client' },
					],
				},
			],
		}),
	],
});
