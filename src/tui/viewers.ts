import {
  CodeRenderable,
  DiffRenderable,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import type { BoxRenderable, CliRenderer, KeyEvent } from "@opentui/core";
import * as fs from "node:fs";
import { codeSyntaxStyle } from "./art";
import { COLORS } from "./theme";
import { detectLanguage, stripCwd } from "./tools";

interface ViewerContext {
  renderer: CliRenderer;
  overlay: BoxRenderable;
  cwd: string;
  nextId: () => string;
  hideMainTui: () => void;
  closeViewer: (offKey: () => void) => void;
  onReadError: (filePath: string) => void;
}

export function openDiffViewer(ctx: ViewerContext, filePath: string, diffContent: string): void {
  const { renderer, overlay, nextId } = ctx;
  overlay.add(createTitleBar(ctx, filePath));

  const diffScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    id: "diff-scroll",
    scrollY: true,
    stickyScroll: false,
    width: "100%",
  });
  diffScroll.add(
    new DiffRenderable(renderer, {
      diff: diffContent,
      fg: COLORS.white,
      id: nextId(),
      lineNumberFg: COLORS.dim,
      showLineNumbers: true,
      syntaxStyle: codeSyntaxStyle,
      view: "unified",
      width: "100%",
    }),
  );
  overlay.add(diffScroll);

  const commandLine = addViewerChrome(ctx);
  ctx.hideMainTui();
  overlay.focus();
  const offKey = installVimKeys(ctx.renderer, diffScroll, commandLine, () =>{ 
    ctx.closeViewer(offKey); },
  );
}

export function openCodeViewer(ctx: ViewerContext, filePath: string): void {
  let content = '';
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    ctx.onReadError(filePath);
    return;
  }

  const { renderer, overlay, nextId } = ctx;
  overlay.add(createTitleBar(ctx, stripCwd(filePath, ctx.cwd)));

  const codeScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    id: "code-scroll",
    scrollX: true,
    scrollY: true,
    stickyScroll: false,
    width: "100%",
  });
  codeScroll.add(
    new CodeRenderable(renderer, {
      content,
      filetype: detectLanguage(filePath),
      id: nextId(),
      selectable: true,
      syntaxStyle: codeSyntaxStyle,
      width: "100%",
    }),
  );
  overlay.add(codeScroll);

  const commandLine = addViewerChrome(ctx);
  ctx.hideMainTui();
  overlay.focus();
  const offKey = installVimKeys(ctx.renderer, codeScroll, commandLine, () =>{ 
    ctx.closeViewer(offKey); },
  );
}

function createTitleBar(ctx: ViewerContext, filePath: string): TextRenderable {
  return new TextRenderable(ctx.renderer, {
    attributes: TextAttributes.BOLD,
    content: ` ${filePath} [READ ONLY]`,
    fg: COLORS.link,
    height: 1,
    id: ctx.nextId(),
    width: "100%",
  });
}

function addViewerChrome(ctx: ViewerContext): TextRenderable {
  ctx.overlay.add(
    new TextRenderable(ctx.renderer, {
      content: " j/k scroll  g/G top/bottom  Ctrl+D/U page  :q quit",
      fg: COLORS.dim,
      height: 1,
      id: ctx.nextId(),
      width: "100%",
    }),
  );

  const commandLine = new TextRenderable(ctx.renderer, {
    content: "",
    fg: COLORS.white,
    height: 1,
    id: ctx.nextId(),
    visible: false,
    width: "100%",
  });
  ctx.overlay.add(commandLine);
  return commandLine;
}

function installVimKeys(
  renderer: CliRenderer,
  scrollBox: ScrollBoxRenderable,
  commandLine: TextRenderable,
  close: () => void,
): () => void {
  let commandMode = false;
  let commandBuffer = "";
  let countBuffer = "";
  const scrollStep = 5;

  const getCount = () => (countBuffer.length > 0 ? Math.max(1, Number.parseInt(countBuffer, 10)) : 1);
  const resetCount = () => {
    countBuffer = "";
  };

  const handler = (event: KeyEvent) => {
    if (event.ctrl && event.name === "c") { close();; return;}
    if (event.name === "escape") {
      if (!commandMode) { close();; return;}
      commandMode = false;
      commandBuffer = "";
      commandLine.content = "";
      commandLine.visible = false;
      resetCount();
      return;
    }
    if (commandMode) {
      if (event.name === "return") {
        if (commandBuffer === "q" || commandBuffer === "q!") { close();; return;}
        commandMode = false;
        commandBuffer = "";
        commandLine.content = "";
        commandLine.visible = false;
        resetCount();
        return;
      }
      if (event.name === "backspace") {
        commandBuffer = commandBuffer.slice(0, -1);
        commandLine.content = commandBuffer ? `:${commandBuffer}` : "";
        commandLine.visible = Boolean(commandBuffer);
        return;
      }
      if (event.name && event.name.length === 1) {
        commandBuffer += event.name;
        commandLine.content = `:${commandBuffer}`;
      }
      return;
    }

    if (event.name === ":" || event.name === "/") {
      commandMode = true;
      commandBuffer = "";
      commandLine.content = event.name;
      commandLine.visible = true;
      resetCount();
      return;
    }
    if (event.name >= "1" && event.name <= "9") {
      countBuffer += event.name;
      return;
    }
    if (event.name === "0" && countBuffer.length > 0) {
      countBuffer += "0";
      return;
    }

    const n = getCount();
    if (event.name === "j" || event.name === "down") {scrollBox.scrollBy(n);}
    else if (event.name === "k" || event.name === "up") {scrollBox.scrollBy(-n);}
    else if (event.name === "h") {scrollBox.scrollBy({ x: -n, y: 0 });}
    else if (event.name === "l") {scrollBox.scrollBy({ x: n, y: 0 });}
    else if (event.name === "g" && !event.ctrl && !event.shift) {
      if (countBuffer === "g") {scrollBox.scrollTo(0);}
      else {
        countBuffer = "g";
        return;
      }
    } else if ((event.name === "g" && event.shift) || event.name === "G") {
      scrollBox.scrollTo(countBuffer.length > 0 ? Number.parseInt(countBuffer, 10) : 999_999);
    } else if (event.ctrl && event.name === "d") {scrollBox.scrollBy(scrollStep * 2 * n);}
    else if (event.ctrl && event.name === "u") {scrollBox.scrollBy(-scrollStep * 2 * n);}
    else if (event.ctrl && event.name === "f") {scrollBox.scrollBy(scrollStep * 4 * n);}
    else if (event.ctrl && event.name === "b") {scrollBox.scrollBy(-scrollStep * 4 * n);}
    else if (event.ctrl && event.name === "e") {scrollBox.scrollBy(n);}
    else if (event.ctrl && event.name === "y") {scrollBox.scrollBy(-n);}
    else if (event.name === "0") {scrollBox.scrollLeft = 0;}
    else if (event.name === "$") {scrollBox.scrollLeft = scrollBox.scrollWidth;}
    else if (event.name === "q") { close();; return;}

    resetCount();
  };
  renderer.keyInput.on("keypress", handler);
  return () => renderer.keyInput.off("keypress", handler);
}
