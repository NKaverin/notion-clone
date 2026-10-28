// A block's content is a list of spans
export type Span = {
    text: string;
    bold: boolean;
    italic: boolean;
};

export function span(text: string, bold = false, italic = false): Span {
    return { text, bold, italic };
}

export function plainText(spans: Span[]): string {
    return spans.map((s) => s.text).join("");
}

// Drop empty ones, merge neighbours
export function normalize(spans: Span[]) : Span[] {
    const result: Span[] = [];
    for (const s of spans) {
        if (s.text === "") {
            continue;
        }
        const last = result[result.length - 1];
        if (last !== undefined && last.bold === s.bold && last.italic === s.italic) {
            last.text += s.text;
        } else {
            result.push({ ...s });
        }
    }
    return result;
}

// Cut at a character offset into two
export function splitSpans(spans: Span[], offset: number): [Span[], Span[]] {
    const before: Span[] = [];
    const after: Span[] = [];
    let start = 0;
    for (const s of spans) {
        const end = start + s.text.length;
        if (end <= offset) {
            before.push({ ...s });
        } else if (start >= offset) {
            after.push({ ...s });
        } else {
            before.push({ ...s, text: s.text.slice(0, offset - start) });
            after.push({ ...s, text: s.text.slice(offset - start) });
        }
        start = end;
    }
    return [before, after];
}

// Ctrl+B or Ctrl+I
export function toggleMark(spans: Span[], from: number, to: number, mark: "bold" | "italic") : Span[] {
    const [before, rest] = splitSpans(spans, from);
    const [middle, after] = splitSpans(rest, to-from);
    const turnOn = !middle.every((s) => s[mark]);
    const changed = middle.map((s) => ({ ...s, [mark]: turnOn}));
    return normalize([...before, ...changed, ...after]);
}