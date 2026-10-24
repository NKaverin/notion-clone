// A page is an ordered list of blocks
export type Block = {
    id: string;
    type: "paragraph";
    text: string;
};

export function newBlock(text: string): Block {
    return { id: crypto.randomUUID(), type: "paragraph", text };
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
        return el;
    }

    for (const block of blocks) {
        container.append(renderBlock(block));
    }
    return container;
}