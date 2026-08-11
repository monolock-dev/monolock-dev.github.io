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
