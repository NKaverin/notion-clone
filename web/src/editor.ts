// A page is an ordered list of blocks
export type Block = {
    id: string;
    type: "paragraph";
    text: string;
};

export function newBlock(text: string): Block {
    return { id: crypto.randomUUID(), type: "paragraph", text };
}

function caretOffset(el: HTMLElement): number {
    const selection = window.getSelection()!;
    const caret = selection.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(caret.startContainer, caret.startOffset);
    return before.toString().length;
}

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

export function createEditor(blocks: Block[]): HTMLElement {
    const container = document.createElement("div");

    function renderBlock(block: Block): HTMLElement {
        const el = document.createElement("div");
        el.contentEditable = "true";
        el.dataset.id = block.id;
        el.textContent = block.text;
        // style for empty div
        el.style.minHeight = "1.5em";

        el.addEventListener("input", () => {
            block.text = el.textContent ?? "";
            console.table(blocks);
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
        });
        return el;
    }

    function splitBlock(block: Block, el: HTMLElement) {
        const offset = caretOffset(el);
        const below = newBlock(block.text.slice(offset));
        block.text = block.text.slice(0, offset);
        el.textContent = block.text;
        blocks.splice(blocks.indexOf(block) + 1, 0, below);
        const belowEl = renderBlock(below);
        el.after(belowEl);
        placeCaret(belowEl, 0);
        console.table(blocks);
    }

    for (const block of blocks) {
        container.append(renderBlock(block));
    }
    return container;
}