import katex from "katex";
import "katex/dist/katex.min.css";
import { ATOM, insertMath, insertText, normalize, plainText, span, splitSpans, toggleMark, type Span } from "./spans";

// enums generate JavaScript, union vanish on compile
export type BlockType = "paragraph" | "h1" | "h2" | "h3" | "bullet" | "equation";

// A page is an ordered list of blocks
export type Block = {
    id: string;
    type: BlockType;
    spans:  Span[];
};

export function newBlock(text: string, type: BlockType = "paragraph"): Block {
    return { id: crypto.randomUUID(), type, spans: text === "" ? [] : [span(text)]  };
}

// The HTML element each block type
const TAGS: Record<BlockType, string> = {
    paragraph: "div",
    h1: "h1",
    h2: "h2",
    h3: "h3",
    bullet: "div",
    equation: "div",
};

// Typing one of these at the start turns it into that type
const SHORTCUTS: [string, BlockType][] = [
    ["# ", "h1"],
    ["## ", "h2"],
    ["### ", "h3"],
    ["- ", "bullet"],
    ["$$ ", "equation"],
];

// Characters in a range, counting each inline equation as one
function rangeLength(range: Range): number {
    const fragment = range.cloneContents();
    for (const atom of fragment.querySelectorAll("[data-math]")) {
        atom.replaceWith(ATOM);
    }
    return fragment.textContent!.length;
}
// Calculate the offset to the caret within an element
function caretOffset(el: HTMLElement): number {
    const selection = window.getSelection()!;
    const caret = selection.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(caret.startContainer, caret.startOffset);
    return rangeLength(before);
}

function domPoint(el: HTMLElement, offset: number) : [Node, number] {
    let remaining = offset;
    let last: [Node, number] = [el, 0];
    // Depth-first walk
    function walk(node: Node): [Node, number] | null {
        const children = [...node.childNodes];
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.nodeType === Node.TEXT_NODE) {
                const length = child.textContent!.length;
                if (remaining <= length) {
                    return [child, remaining];
                }
                remaining -= length;
                last = [child, length];
            } else if (child instanceof HTMLElement && child.dataset.math !== undefined) {
                if (remaining ===0) {
                    return [node, i];
                }
                remaining -= 1;
                last = [node, i + 1];
            } else {
                const found = walk(child);
                if (found !== null) {
                    return found;
                }
            }
        }
        return null;
    }
    return walk(el) ?? last;
}

// Put the caret into offset within an element
function placeCaret(el: HTMLElement, offset: number) {
    el.focus();
    const range = document.createRange();
    const [node, nodeOffset] = domPoint(el, offset);
    range.setStart(node, nodeOffset);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
}

// Is the caret on el's first/last line?
function caretOnEdgeLine(el: HTMLElement, edge: "first" | "last"): boolean {
    const selection = window.getSelection()!;
    if (!selection.isCollapsed) {
        return false;
    }
    const caret = selection.getRangeAt(0).getBoundingClientRect();
    // an empty block = no box
    if (caret.height === 0) {
        return true;
    }
    const box = el.getBoundingClientRect();
    if (edge === "first") {
        return caret.top - box.top < caret.height / 2;
    }
    return box.bottom - caret.bottom < caret.height / 2;
}

// Draw spans into el
function renderSpans(el: HTMLElement, spans: Span[]) {
    const nodes = spans.map((s) => {
        if (s.math !== undefined) {
            const atom = document.createElement("span");
            atom.contentEditable = "false";
            atom.dataset.math = s.math;
            katex.render(s.math, atom, { throwOnError: false });
            return atom;
        }
        let node: Node = document.createTextNode(s.text);
        if (s.italic) {
            const em = document.createElement("em");
            em.append(node);
            node = em;
        }
        if (s.bold) {
            const strong = document.createElement("strong");
            strong.append(node);
            node = strong;
        }
        return node;
    });
    if (plainText(spans).endsWith("\n")) {
        nodes.push(document.createElement("br"));
    }
    el.replaceChildren(...nodes);
}

// Read whatever DOM has, accepts what the browser may produce
function readSpans(el: Node, bold = false, italic = false): Span[] {
    const spans: Span[] = [];
    for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            spans.push(span(child.textContent ?? "", bold, italic));
        } else if (child instanceof HTMLElement && child.dataset.math !== undefined) {
            spans.push({ text: ATOM, bold, italic, math: child.dataset.math });
        } else if (child instanceof HTMLElement) {
            const tag = child.tagName;
            const childBold = bold || tag === "STRONG" || tag === "B";
            const childItalic = italic || tag === "EM" || tag === "I";
            spans.push(...readSpans(child, childBold, childItalic));
        }
    }
    return spans;
}

// The selection as character offsets
function selectionOffsets(el: HTMLElement) : [number, number] {
    const range = window.getSelection()!.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(range.startContainer, range.startOffset);
    const start = rangeLength(before);
    return [start, start + rangeLength(range)];
}

// Select chars within el
function selectRange(el: HTMLElement, start: number, end: number) {
    const range = document.createRange();
    const [startNode, startOffset] = domPoint(el, start);
    const [endNode, endOffset] = domPoint(el, end);
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
}

export function createEditor(blocks: Block[]): HTMLElement {
    const container = document.createElement("div");
    // Put the caret into a block, an equation has no caret
    function focusBlock(el: HTMLElement, offset: number) {
        const block = blocks.find((b) => b.id === el.dataset.id)!;
        if (block.type === "equation") {
            editEquation(block, el);
            return;
        }
        placeCaret(el, offset);
    }
    // After finishing an equation - move below
    function moveBelow(block: Block, el: HTMLElement) {
        const next = el.nextElementSibling as HTMLElement | null;
        if (next !== null) {
            focusBlock(next, 0);
            return;
        }
        const below = newBlock("");
        blocks.splice(blocks.indexOf(block) + 1, 0, below);
        const belowEl = renderBlock(below);
        el.after(belowEl);
        placeCaret(belowEl, 0);
    }
    // An equation block is never contenteditable
    function renderEquation(block: Block): HTMLElement {
        const el = document.createElement(TAGS.equation);
        el.dataset.id = block.id;
        el.style.minHeight = "1.5em";
        el.style.cursor = "pointer";
        const source = plainText(block.spans);
        if (source === "") {
            el.textContent = "Empty equation";
            el.style.color = "gray";
        } else {
            // bad Latex in red instead of throwing
            katex.render(source, el, { displayMode: true, throwOnError: false});
        }
        el.addEventListener("click", () => editEquation(block, el));
        return el;
    }

    function editEquation(block: Block, el: HTMLElement) {
        const input = document.createElement("textarea");
        input.dataset.id = block.id;
        input.value = plainText(block.spans);
        input.style.width = "100%";
        // not sure about monospace
        input.style.fontFamily = "monospace";
        let continueBelow = false;
        input.addEventListener("keydown", (event) => {
            // Enter or Escape finishes, shift+Enter = new line
            const enter = event.key === "Enter" && !event.shiftKey && !event.isComposing;
            if (enter || event.key === "Escape") {
                event.preventDefault();
                continueBelow = enter;
                input.blur();
            }
        });
        input.addEventListener("blur", () => {
            block.spans = input.value === "" ? [] : [span(input.value)];
            const rendered = renderEquation(block);
            input.replaceWith(rendered);
            if (continueBelow) {
                moveBelow(block, rendered);
            }
        });
        el.replaceWith(input);
        input.focus();
    }

    function renderBlock(block: Block): HTMLElement {
        if (block.type === "equation") {
            return renderEquation(block);
        }
        const el = document.createElement(TAGS[block.type]);
        el.contentEditable = "true";
        el.dataset.id = block.id;
        renderSpans(el, block.spans);
        el.style.whiteSpace = "pre-wrap";
        // style for empty div
        el.style.minHeight = "1.5em";
        if (block.type === "bullet") {
            el.style.display = "list-item";
            el.style.marginLeft = "1.5em";
        } 

        // Inline equation click
        el.addEventListener("click", (event) => {
            const atom = (event.target as Element).closest<HTMLElement>("[data-math]");
            if (atom === null) {
                return;
            }
            const before = document.createRange();
            before.selectNodeContents(el);
            before.setEndBefore(atom);
            const offset = rangeLength(before);
            const source = "$" + atom.dataset.math!;
            block.spans = insertText(block.spans, offset, offset + 1, source);
            renderSpans(el, block.spans);
            placeCaret(el, offset + source.length);
        });
        
        el.addEventListener("input", (event) => {
            block.spans = normalize(readSpans(el));
            if (block.type === "paragraph") {
                for (const [prefix, type] of SHORTCUTS) {
                    if (plainText(block.spans).startsWith(prefix)) {
                        changeType(block, el, type, prefix.length);
                        return;
                    }
                }
            }
            // Do not redraw if IME composition
            if ((event as InputEvent).isComposing) {
                return;
            }
            if (convertInlineMath(block, el)) {
                return;
            }
            redraw(block, el);
        });
        el.addEventListener("compositionend", () => {
            redraw(block, el);
        });
        el.addEventListener("beforeinput", (event) => {
            if (event.inputType === "insertLineBreak") {
                event.preventDefault();
                const [start, end] = selectionOffsets(el);
                block.spans = insertText(block.spans, start, end, "\n");
                renderSpans(el, block.spans);
                placeCaret(el, start + 1);
            }
        });
        // Paste only the plain text
        el.addEventListener("paste", (event) => {
            event.preventDefault();
            const text = event.clipboardData!.getData("text/plain").replaceAll("\r\n", "\n");
            const [start, end] = selectionOffsets(el);
            block.spans = insertText(block.spans, start, end, text);
            renderSpans(el, block.spans);
            placeCaret(el, start + text.length);
        });
        el.addEventListener("keydown", (event) => {
            // eg Japanese
            if (event.isComposing) {
                return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                splitBlock(block, el);
            }
            // CTRL+B / Ctrl+I or cmd
            const key = event.key.toLowerCase();
            if ((event.ctrlKey || event.metaKey) && (key === "b" || key === "i")) {
                event.preventDefault();
                const [start, end] = selectionOffsets(el);
                if (start === end) {
                    return;
                }
                block.spans = toggleMark(block.spans, start, end, key === "b" ? "bold" : "italic");
                renderSpans(el, block.spans);
                selectRange(el, start, end);
            }
            // Backspace at the start turns it back to a paragraph
            if (
                event.key === "Backspace" &&
                block.type !== "paragraph" &&
                window.getSelection()!.isCollapsed &&
                caretOffset(el) === 0
            ) {
                event.preventDefault();
                changeType(block, el, "paragraph", 0);
                return;
            }
            // Arrows navigation
            if (event.key === "ArrowUp" && caretOnEdgeLine(el, "first")) {
                const above = el.previousElementSibling as HTMLElement | null;
                if (above !== null) {
                    event.preventDefault();
                    focusBlock(above, above.textContent!.length);
                }
            }
            if (event.key === "ArrowDown" && caretOnEdgeLine(el, "last")) {
                const below = el.nextElementSibling as HTMLElement | null;
                if (below !== null) {
                    event.preventDefault();
                    focusBlock(below, 0);
                }
            }
            if (event.key === "Backspace" && joinWithPrevious(block, el)) {
                event.preventDefault();
            }
        });
        return el;
    }

    // On Enter: create a new block and put the rest of previous block into new one
    function splitBlock(block: Block, el: HTMLElement) {
        // Enter on an empty bullet ends the list
        if (block.type === "bullet" && plainText(block.spans) === "") {
            changeType(block, el, "paragraph", 0);
            return;
        }
        const offset = caretOffset(el);
        // A bullet continues the list
        const belowType = block.type === "bullet" ? "bullet" : "paragraph";
        const [before, after] = splitSpans(block.spans, offset);
        const below = newBlock("", belowType);
        below.spans = after;
        block.spans = before;
        renderSpans(el, block.spans);        
        blocks.splice(blocks.indexOf(block) + 1, 0, below);
        const belowEl = renderBlock(below);
        el.after(belowEl);
        // Place the caret at the start of a new block
        placeCaret(belowEl, 0);
    }

    // Backspace at the very start of a block: appent to the previous one and remove it
    // False otherwise
    function joinWithPrevious(block: Block, el: HTMLElement): boolean {
        const index = blocks.indexOf(block);
        const selection = window.getSelection()!;
        if (index === 0 || !selection.isCollapsed || caretOffset(el) !== 0) {
            return false;
        }
        const above = blocks[index - 1];
        if (above.type === "equation") {
            return false;
        }
        const aboveEl = el.previousElementSibling as HTMLElement;
        const joinAt = plainText(above.spans).length;
        above.spans = normalize([...above.spans, ...block.spans]);
        renderSpans(aboveEl, above.spans);
        blocks.splice(index, 1);
        el.remove();
        placeCaret(aboveEl, joinAt);
        return true;
    }
    // Inline math is inbetween $
    function convertInlineMath(block: Block, el: HTMLElement): boolean {
        const offset = caretOffset(el);
        const before = plainText(block.spans).slice(0, offset);
        const match = before.match(/\$([^\s$](?:[^$\n]*[^\s$])?)\$$/);
        if (match === null) {
            return false;
        }
        const start = offset - match[0].length;
        block.spans = insertMath(block.spans, start, offset, match[1]);
        renderSpans(el, block.spans);
        placeCaret(el, start + 1);
        return true;
    }

    function redraw(block: Block, el: HTMLElement) {
        const offset = caretOffset(el);
        renderSpans(el, block.spans);
        placeCaret(el, offset);
    }

    function changeType(block: Block, el: HTMLElement, type: BlockType, removeChars: number) {
        const offset = caretOffset(el);
        block.type = type;
        block.spans = splitSpans(block.spans, removeChars)[1];
        const replacement = renderBlock(block);
        el.replaceWith(replacement);
        // It is not editable, we do not need caret
        if (type === "equation") {
            editEquation(block, replacement);
            return;
        }
        placeCaret(replacement, Math.max(0, offset - removeChars));
    }

    for (const block of blocks) {
        container.append(renderBlock(block));
    }
    return container;
}