import { normalize, plainText, span, splitSpans, type Span } from "./spans";

// enums generate JavaScript, union vanish on compile
export type BlockType = "paragraph" | "h1" | "h2" | "h3" | "bullet";

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
};

// Typing one of these at the start turns it into that type
const SHORTCUTS: [string, BlockType][] = [
    ["# ", "h1"],
    ["## ", "h2"],
    ["### ", "h3"],
    ["- ", "bullet"],
];

// Calculate the offset to the caret within an element
function caretOffset(el: HTMLElement): number {
    const selection = window.getSelection()!;
    const caret = selection.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(caret.startContainer, caret.startOffset);
    return before.toString().length;
}

function domPoint(el: HTMLElement, offset: number) : [Node, number] {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let last: Node | null = null;
    for (let node = walker.nextNode(); node !== null; node= walker.nextNode()) {
        const length = node.textContent!.length;
        if (remaining <= length) {
            return [node, remaining];
        }
        remaining -= length;
        last = node;
    }
    // Past the end or no text
    return last === null ? [el, 0] : [last, last.textContent!.length];
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
    el.replaceChildren(...nodes);
}

// Read whatever DOM has, accepts what the browser may produce
function readSpans(el: Node, bold = false, italic = false): Span[] {
    const spans: Span[] = [];
    for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            spans.push(span(child.textContent ?? "", bold, italic));
        } else if (child instanceof HTMLElement) {
            const tag = child.tagName;
            const childBold = bold || tag === "STRONG" || tag == "B";
            const childItalic = italic || tag === "EM" || tag === "I";
            spans.push(...readSpans(child, childBold, childItalic));
        }
    }
    return spans;
}

export function createEditor(blocks: Block[]): HTMLElement {
    const container = document.createElement("div");

    function renderBlock(block: Block): HTMLElement {
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

        el.addEventListener("input", () => {
            block.spans = normalize(readSpans(el));
            console.log("spans", block.spans);
            if (block.type === "paragraph") {
                for (const [prefix, type] of SHORTCUTS) {
                    if (plainText(block.spans).startsWith(prefix)) {
                        changeType(block, el, type, prefix.length);
                        return;
                    }
                }
            }
        });
        el.addEventListener("keydown", (event) => {
            // eg Japanese
            if (event.isComposing) {
                return;
            }
            if (event.key === "Enter") {
                event.preventDefault();
                splitBlock(block, el);
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
                    placeCaret(above, above.textContent!.length);
                }
            }
            if (event.key === "ArrowDown" && caretOnEdgeLine(el, "last")) {
                const below = el.nextElementSibling as HTMLElement | null;
                if (below !== null) {
                    event.preventDefault();
                    placeCaret(below, 0);
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
        const aboveEl = el.previousElementSibling as HTMLElement;
        const joinAt = plainText(above.spans).length;
        above.spans = normalize([...above.spans, ...block.spans]);
        renderSpans(aboveEl, above.spans);
        blocks.splice(index, 1);
        el.remove();
        placeCaret(aboveEl, joinAt);
        return true;
    }

    function changeType(block: Block, el: HTMLElement, type: BlockType, removeChars: number) {
        const offset = caretOffset(el);
        block.type = type;
        block.spans = splitSpans(block.spans, removeChars)[1];
        const replacement = renderBlock(block);
        el.replaceWith(replacement);
        placeCaret(replacement, Math.max(0, offset - removeChars));
    }

    for (const block of blocks) {
        container.append(renderBlock(block));
    }
    return container;
}