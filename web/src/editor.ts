// enums generate JavaScript, union vanish on compile
export type BlockType = "paragraph" | "h1" | "h2" | "h3" | "bullet";

// A page is an ordered list of blocks
export type Block = {
    id: string;
    type: BlockType;
    text: string;
};

export function newBlock(text: string, type: BlockType = "paragraph"): Block {
    return { id: crypto.randomUUID(), type, text };
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

// Put the caret into offset within an element
function placeCaret(el: HTMLElement, offset: number) {
    el.focus();
    const range = document.createRange();
    const text = el.firstChild;
    if (text === null || text.nodeType !== Node.TEXT_NODE) {
        range.setStart(el, 0);
    } else {
        range.setStart(text, Math.min(offset, text.textContent!.length));
    }
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

export function createEditor(blocks: Block[]): HTMLElement {
    const container = document.createElement("div");

    function renderBlock(block: Block): HTMLElement {
        const el = document.createElement(TAGS[block.type]);
        el.contentEditable = "true";
        el.dataset.id = block.id;
        el.textContent = block.text;
        el.style.whiteSpace = "pre-wrap";
        // style for empty div
        el.style.minHeight = "1.5em";
        if (block.type === "bullet") {
            el.style.display = "list-item";
            el.style.marginLeft = "1.5em";
        } 

        el.addEventListener("input", () => {
            block.text = el.textContent ?? "";
            if (block.type === "paragraph") {
                for (const [prefix, type] of SHORTCUTS) {
                    if (block.text.startsWith(prefix)) {
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
        if (block.type === "bullet" && block.text === "") {
            changeType(block, el, "paragraph", 0);
            return;
        }
        const offset = caretOffset(el);
        // A bullet continues the list
        const belowType = block.type === "bullet" ? "bullet" : "paragraph";
        const below = newBlock(block.text.slice(offset), belowType);
        block.text = block.text.slice(0, offset);
        el.textContent = block.text;
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
        const joinAt = above.text.length;
        above.text += block.text;
        aboveEl.textContent = above.text;
        blocks.splice(index, 1);
        el.remove();
        placeCaret(aboveEl, joinAt);
        return true;
    }

    function changeType(block: Block, el: HTMLElement, type: BlockType, removeChars: number) {
        const offset = caretOffset(el);
        block.type = type;
        block.text = block.text.slice(removeChars);
        const replacement = renderBlock(block);
        el.replaceWith(replacement);
        placeCaret(replacement, Math.max(0, offset - removeChars));
    }

    for (const block of blocks) {
        container.append(renderBlock(block));
    }
    return container;
}