import { describe, expect, test } from 'bun:test';

const page = await Bun.file(
  new URL('../src/pages/index.astro', import.meta.url),
).text();

describe('landing page product story', () => {
	test('opens with the product outcome', () => {
		expect(page).toContain('class="site-header"');
		expect(page).toContain('Bring an agent into');
		expect(page).toContain('every action visible before it happens.');
	});

	test('shows concrete first-time prompts', () => {
		expect(page).toContain('id="use-cases-new"');
		expect(page).toContain('Useful from the');
		expect(page).toContain('find why the tests are failing and fix them');
		expect(page).toContain('explain how authentication works here');
	});

	test('covers the real product feature set', () => {
		expect(page).toContain('id="features-new"');
		expect(page).toContain('PLAN MODE');
		expect(page).toContain('SUBAGENTS');
		expect(page).toContain('Hash-anchored edits');
		expect(page).toContain('Semantic code search');
		expect(page).toContain('Headless mode');
		expect(page).toContain('Vim-first viewers');
	});

  test('keeps implementation internals and internal section headings out', () => {
    expect(page).not.toContain('dual-process architecture');
    expect(page).not.toContain('Flue Runtime Server');
    expect(page).not.toContain('harness capabilities');
    expect(page).not.toContain('toolbelt ecosystem');
    expect(page).not.toContain('OpenTUI Core');
  });

	test('keeps setup direct', () => {
		expect(page).toContain('id="get-started-new"');
		expect(page).toContain('Bring it');
		expect(page).toContain('curl -fsSL https://lavalamp.marban.lol/install.sh | bash');
		expect(page).not.toContain('id="faq"');
		expect(page).not.toContain('id="ways-to-run"');
	});

	test('keeps the terminal demo and adds Anime.js motion', () => {
		expect(page).toContain('id="demo"');
		expect(page).toContain('id="tuiMessagesPanel"');
		expect(page).toContain("from 'animejs'");
		expect(page).toContain('prefers-reduced-motion: reduce');
		expect(page).toContain('id="newCopyInstall"');
	});
});
