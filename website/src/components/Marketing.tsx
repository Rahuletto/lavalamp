import { Button, Code } from '@astryxdesign/core';

const initialLavaLampFrame = [
  '       _____',
  '      /     \\',
  '      |_____|',
  '      /  _  \\',
  '     /  ( )  \\',
  '    /    `    \\',
  '   /     _     \\',
  '  /     ( )     \\',
  '  \\      )\\     /',
  '   \\    (  )   /',
  '    \\  ,-(   /',
  '     \\/-----\\/',
  '     |       |',
  '     /       \\',
  '    /________\\--._',
  '               .-._)',
  '              (__',
  '                 -`|E',
].join('\n');

const features = [
  ['Plan mode', 'Design the approach and task list before lavalamp changes a file.', 'Think'],
  ['Parallel subagents', 'Launch up to three isolated research agents and merge their findings into the main thread.', 'Delegate'],
  ['Expert delegation', 'Call focused read-only experts for logic, UI work, refactors, and screenshot analysis.', 'Delegate'],
  ['Hash-anchored edits', 'Apply precise, verified patches instead of rewriting entire files.', 'Edit'],
  ['Permission gates', 'Approve, deny, or permanently allow file changes and shell commands. Unanswered prompts auto-deny.', 'Control'],
  ['Undo and history', 'Inspect the local mutation log and wind file changes back through the ChangeTracker.', 'Control'],
  ['Semantic code search', 'Search behavior by meaning through a persistent workspace vector index shared across sessions.', 'Explore'],
  ['LSP intelligence', 'Navigate definitions and references, inspect symbols, and surface diagnostics from the language server.', 'Explore'],
  ['Persistent memory', 'Store durable project notes and guidelines that carry into future sessions.', 'Remember'],
  ['Resumable sessions', 'Browse past conversations, restore transcripts, or continue directly from the command line.', 'Remember'],
  ['Headless and simple modes', 'Use print, JSON, REPL, or screen-reader-friendly output outside the full-screen TUI.', 'Run'],
  ['Vim-first viewers', 'Inspect code and unified diffs with j/k, page movement, jumps, and familiar quit bindings.', 'Review'],
];

const workflow = [
  ['01', 'Explore', 'Read files, trace symbols with LSP, search by meaning, and ask specialized experts for another angle.'],
  ['02', 'Plan', 'Turn the request into an explicit task list before mutation tools become part of the conversation.'],
  ['03', 'Approve', 'See the exact file or command at the permission boundary. Allow once, deny, or save a rule.'],
  ['04', 'Verify', 'Run the narrowest useful checks, inspect the diff in a Vim-first viewer, and keep a reversible history.'],
];

const comparison = [
  ['Persistent semantic code index', 'Built in and shared across sessions', 'Not built in', 'Not built in', 'Not built in', 'Extension', 'Memory, not a code index'],
  ['Cloudflare model and embedding stack', 'Integrated through Wrangler', 'AI Gateway setup', 'AI Gateway setup', 'Cloudflare provider', 'Cloudflare provider', 'Provider setup'],
  ['Approval-first mutation workflow', 'Default', 'Default', 'Sandbox and approval', 'Configurable', 'Extension', 'Available; yolo default'],
  ['Ready-made specialist roster', 'Eight built-in experts', 'Built-in and custom agents', 'Built-in and custom agents', 'Custom agents', 'Extension', 'Advisor roles'],
  ['Hash-anchored edit and undo loop', 'Built in', 'Conventional edits', 'Patch based', 'Patch based', 'Package', 'Built in'],
  ['Session, project memory, and code index', 'All three built in', 'Session and memory', 'Session and instructions', 'Sessions; no code index', 'Sessions; extensions', 'Sessions and Hindsight; no code index'],
];

export function MarketingTop() {
  return (
    <>
      <div className="hero-shell" id="top">
        <canvas className="hacker-backdrop" id="hackerBackdrop" aria-hidden="true"></canvas>
        <header className="site-header">
          <a className="wordmark" href="#top" aria-label="lavalamp home"><span className="mark">L</span> lavalamp</a>
          <div className="header-actions">
            <Button label="Install" href="#get-started-new" variant="primary" />
            <Button label="View on GitHub" href="https://github.com/rahuletto/lavalamp" target="_blank" rel="noopener noreferrer" variant="secondary" />
          </div>
        </header>

        <main className="hero">
          <div className="hero-copy">
            <h1>Knows your codebase. <em>Not just your prompt.</em></h1>
            <p className="lede">lavalamp remembers your codebase between sessions, finds the right context, and asks before it changes a file or runs a command.</p>
            <div className="hero-actions">
              <Button label="Install lavalamp" href="#get-started-new" variant="primary" size="lg" />
              <Button label="Explore features" href="#features-new" variant="secondary" size="lg" />
            </div>
          </div>

          <div className="hero-terminal" aria-hidden="true">
            <div className="hero-terminal-bar"><span></span><span></span><span></span><strong>lavalamp · ~/project</strong></div>
            <div className="hero-terminal-body">
              <pre className="hero-lamp-ascii" id="heroLavaLampArt">{initialLavaLampFrame}</pre>
              <div className="hero-terminal-session">
                <p><b>›</b> find the failing test and fix the root cause</p>
                <p className="terminal-thinking">Reasoning through the request...</p>
                <p><span>✓</span> read src/cache.ts</p>
                <p><span>✓</span> read tests/cache.test.ts</p>
                <div className="terminal-permission"><strong>Permission required</strong><span>Edit src/cache.ts?</span><small>[y] allow · [n] deny</small></div>
              </div>
            </div>
          </div>
        </main>
      </div>

      <main id="top-content">
        <section className="demo-intro">
          <h2>The interface stays out of your way.</h2>
        </section>
      </main>
    </>
  );
}

export function MarketingBottom() {
  return (
    <main className="after-demo">
      <section id="features-new" className="features">
        <div className="section-heading"><div><h2>Small surface.<br /><span className="script-accent">Serious capability.</span></h2></div><p>Everything the agent needs to understand your codebase and get useful work done, while you stay in charge.</p></div>
        <div className="feature-grid">{features.map(([title, body], index) => <article key={title}><div className="feature-meta-row"><span>{String(index + 1).padStart(2, '0')}</span></div><h3>{title}</h3><p>{body}</p></article>)}</div>
      </section>

      <section className="ownership-section">
        <div className="ownership-copy">
          <h2>Your Cloudflare account.<br />Not another AI subscription.</h2>
          <p>Lavalamp authenticates through Wrangler and sends inference directly to Workers AI on your account. There is no Lavalamp model plan, token bundle, or billing layer between you and Cloudflare.</p>
        </div>
        <div className="ownership-flow" aria-label="Cloudflare authentication flow">
          <div><span>01</span><strong>lavalamp login</strong><p>Reuse Wrangler OAuth instead of pasting another provider key.</p></div>
          <div><span>02</span><strong>Your account</strong><p>Choose a supported Workers AI model and run it on your Cloudflare account.</p></div>
          <div><span>03</span><strong>Direct billing</strong><p>Usage appears in Cloudflare. There is no marked-up agent subscription in the middle.</p></div>
        </div>
      </section>

      <section className="workflow-section">
        <div className="section-heading"><div><h2>Autonomy without<br />the leap of faith.</h2></div><p>The agent can move quickly through read-only work. The moment it wants to change your workspace or execute a command, you are back in the loop.</p></div>
        <div className="workflow-list">{workflow.map(([number, title, body]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p></article>)}</div>
      </section>

      <section className="comparison-section">
        <div className="comparison-heading"><div><h2>The useful parts,<br />already wired together.</h2></div><p>No single checkbox makes Lavalamp different. The advantage is the combination: persistent codebase search, approval-first changes, reliable edits, specialist models, and three layers of project continuity without assembling a plugin stack first.</p></div>
        <div className="comparison-scroll">
          <table>
            <thead><tr><th>Capability</th><th className="is-lavalamp">lavalamp</th><th>Claude Code</th><th>Codex CLI</th><th>OpenCode</th><th>Pi</th><th>Oh My Pi</th></tr></thead>
            <tbody>{comparison.map(([feature, ...values]) => <tr key={feature}><th>{feature}</th>{values.map((value, index) => <td className={index === 0 ? 'is-lavalamp' : ''} key={index}>{value}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="modes-section">
        <div><h2>Stay in the terminal.<br />Or leave the UI behind.</h2></div>
        <div className="mode-list">
          <div><code>lavalamp</code><p>Full interactive TUI with streaming tools, permissions, tasks, and viewers.</p></div>
          <div><code>lavalamp ask</code><p>Read-only exploration when you want answers without workspace mutations.</p></div>
          <div><code>lavalamp -p</code><p>Send one instruction and get one response. It fits neatly into scripts and automation.</p></div>
          <div><code>--simple / --repl</code><p>Plain terminal output for scrollback, screen readers, and lightweight sessions.</p></div>
        </div>
      </section>

      <section id="get-started-new" className="get-started">
        <div><h2>Bring it home.</h2><p>Use your Cloudflare account. Keep your workspace local. Start building.</p></div>
        <div className="install-card"><Code>curl -fsSL https://lavalamp.marban.lol/install.sh | bash</Code><button id="newCopyInstall" type="button">Copy command</button></div>
      </section>
      <footer className="site-footer">
        <a className="footer-wordmark" href="#top"><span className="mark">L</span> lavalamp</a>
        <p>A local coding agent that asks before it changes your workspace.</p>
        <div className="footer-links">
          <a href="https://github.com/rahuletto/lavalamp">GitHub ↗</a>
          <a href="https://github.com/rahuletto/lavalamp#readme">Readme ↗</a>
          <a href="https://github.com/rahuletto/lavalamp/blob/main/LICENSE">MIT License ↗</a>
        </div>
        <span className="footer-meta">© {new Date().getFullYear()} lavalamp · Powered by Cloudflare Workers AI</span>
      </footer>
    </main>
  );
}
