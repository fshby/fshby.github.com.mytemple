import { EditorState, EditorSelection, Transaction } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, deleteLine, history, undo, redo } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap, search, SearchQuery, SearchCursor, getSearchQuery, setSearchQuery, openSearchPanel, findNext, findPrevious } from "@codemirror/search";
import { tags } from "@lezer/highlight";

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--cm-heading)" },
  { tag: tags.heading1, color: "var(--cm-heading-strong)", fontWeight: "700" },
  { tag: tags.heading2, color: "var(--cm-heading-strong)", fontWeight: "650" },
  { tag: tags.heading3, color: "var(--cm-heading)", fontWeight: "650" },
  { tag: tags.link, color: "var(--cm-link)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--cm-url)" },
  { tag: tags.emphasis, color: "var(--cm-emphasis)", fontStyle: "italic" },
  { tag: tags.strong, color: "var(--cm-strong)", fontWeight: "700" },
  { tag: tags.monospace, color: "var(--cm-code)" },
  { tag: tags.comment, color: "var(--cm-comment)" },
  { tag: tags.keyword, color: "var(--cm-keyword)" },
  { tag: tags.string, color: "var(--cm-string)" },
  { tag: tags.number, color: "var(--cm-number)" },
  { tag: tags.bool, color: "var(--cm-bool)" },
  { tag: tags.typeName, color: "var(--cm-type)" },
  { tag: tags.className, color: "var(--cm-type)" },
  { tag: tags.propertyName, color: "var(--cm-property)" },
  { tag: tags.operator, color: "var(--cm-operator)" },
  { tag: tags.punctuation, color: "var(--cm-punctuation)" },
  { tag: tags.invalid, color: "var(--cm-invalid)", textDecoration: "underline wavy" },
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    minWidth: "0",
    color: "var(--text)",
    backgroundColor: "transparent",
    fontSize: "var(--doc-font-size)",
    "--cm-heading": "var(--accent-strong)",
    "--cm-heading-strong": "var(--accent-strong)",
    "--cm-link": "#2563eb",
    "--cm-url": "#4338ca",
    "--cm-emphasis": "var(--text)",
    "--cm-strong": "var(--text)",
    "--cm-code": "var(--code-text)",
    "--cm-comment": "var(--muted)",
    "--cm-keyword": "#7c3aed",
    "--cm-string": "#047857",
    "--cm-number": "#b45309",
    "--cm-bool": "#be123c",
    "--cm-type": "#0369a1",
    "--cm-property": "#0f766e",
    "--cm-operator": "#475569",
    "--cm-punctuation": "var(--muted)",
    "--cm-invalid": "#dc2626",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
    lineHeight: "1.72",
  },
  ".cm-content": {
    padding: "26px max(28px, calc((100% - 800px) / 2)) 60vh",
    caretColor: "var(--accent-strong)",
  },
  ".cm-line": { padding: "0 2px" },
  ".cm-gutters": {
    backgroundColor: "color-mix(in srgb, var(--surface-1) 92%, transparent)",
    color: "var(--muted)",
    borderRight: "1px solid var(--hairline)",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent) !important",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent-strong)" },
  ".cm-panels": {
    backgroundColor: "var(--surface-1)",
    color: "var(--text)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--surface-1)",
    color: "var(--text)",
    border: "1px solid var(--line)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 40%, transparent) !important",
    borderRadius: "2px",
    boxShadow: "0 0 0 1px color-mix(in srgb, var(--accent-strong) 50%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--accent-strong) 55%, transparent) !important",
    boxShadow: "0 0 0 2px var(--accent-strong)",
  },
});

const professionalKeymap = [
  {
    key: "Mod-d",
    run(view) {
      const changes = view.state.changeByRange((range) => {
        const doc = view.state.doc;
        const first = doc.lineAt(range.from);
        // 选中多行时复制全部所选行；选区落在下一行行首时归属上一行，
        // 与 moveCurrentLine 行为一致，避免多复制一条空行。
        const last = doc.lineAt(Math.max(range.from, range.to - 1));
        const text = doc.sliceDoc(first.from, last.to);
        const insert = `\n${text}`;
        return {
          changes: { from: last.to, insert },
          range: EditorSelection.cursor(last.to + insert.length),
        };
      });
      view.dispatch(changes);
      return true;
    },
  },
  {
    key: "Shift-Alt-ArrowUp",
    preventDefault: true,
    run: (view) => moveCurrentLine(view, -1),
  },
  {
    key: "Shift-Alt-ArrowDown",
    preventDefault: true,
    run: (view) => moveCurrentLine(view, 1),
  },
  { key: "Mod-Shift-k", run: deleteLine },
  // Native undo/redo: replaying transactions incrementally avoids the
  // full-document re-render flicker that a whole-doc replace would cause.
  { key: "Mod-z", run: undo, preventDefault: true },
  { key: "Mod-y", run: redo, preventDefault: true },
  { key: "Mod-Shift-z", run: redo, preventDefault: true },
  { key: "Shift-Mod-z", run: redo, preventDefault: true },
  // VSCode Markdown All-in-One style toggles.
  { key: "Alt-s", run: toggleStrikethrough, preventDefault: true },
  { key: "Alt-c", run: toggleTaskLine, preventDefault: true },
  ...closeBracketsKeymap,
  ...foldKeymap,
  // 移除 searchKeymap 中的 Mod-d（selectNextOccurrence），
  // 避免与上方自定义的「向下复制选中行」冲突；保留其余搜索快捷键。
  ...searchKeymap.filter((binding) => binding.key !== "Mod-d"),
  ...defaultKeymap.filter((binding) => !/^(Mod-z|Mod-y|Mod-Shift-z|Tab|Mod-b|Mod-i)$/.test(binding.key || "")),
];

function wrapSelectionWith(view, marker) {
  const { state, dispatch } = view;
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    const wrapped = `${marker}${selected || "文本"}${marker}`;
    return {
      changes: { from: range.from, to: range.to, insert: wrapped },
      range: selected
        ? EditorSelection.range(range.from + marker.length, range.to + marker.length)
        : EditorSelection.range(range.from + marker.length, range.from + marker.length + 2),
    };
  });
  dispatch(changes, { scrollIntoView: true });
  return true;
}

function toggleStrikethrough(view) {
  return wrapSelectionWith(view, "~~");
}

function toggleTaskLine(view) {
  const { state, dispatch } = view;
  const doc = state.doc;
  const changes = state.changeByRange((range) => {
    const line = doc.lineAt(range.from);
    const text = line.text;
    const taskMatch = text.match(/^(\s*(?:[-*]|\d+[.)])\s+)\[([ xX])\]/);
    if (taskMatch) {
      const checked = taskMatch[2] !== " " && taskMatch[2].toLowerCase() !== " ";
      const replacement = text.replace(taskMatch[0], `${taskMatch[1]}[${checked ? " " : "x"}]`);
      return {
        changes: { from: line.from, to: line.to, insert: replacement },
        range: EditorSelection.range(line.from + range.from - line.from, line.from + range.to - line.from),
      };
    }
    const listMatch = text.match(/^(\s*(?:[-*]|\d+[.)])\s+)(.*)$/);
    if (listMatch) {
      const replacement = `${listMatch[1]}[ ] ${listMatch[2]}`;
      return {
        changes: { from: line.from, to: line.to, insert: replacement },
        range,
      };
    }
    return { range };
  });
  if (changes.changes.empty) return false;
  dispatch(changes, { scrollIntoView: true });
  return true;
}

function moveCurrentLine(view, direction) {
  const selection = view.state.selection.main;
  const doc = view.state.doc;
  const first = doc.lineAt(selection.from);
  // A selection ending at the next line's start belongs to the previous line.
  const last = doc.lineAt(Math.max(selection.from, selection.to - 1));
  const targetNumber = direction < 0 ? first.number - 1 : last.number + 1;
  if (targetNumber < 1 || targetNumber > doc.lines) return true;

  const target = doc.line(targetNumber);
  const block = doc.sliceString(first.from, last.to);
  const targetText = doc.sliceString(target.from, target.to);
  const replacement = direction < 0 ? `${block}\n${targetText}` : `${targetText}\n${block}`;
  const from = direction < 0 ? target.from : first.from;
  const to = direction < 0 ? last.to : target.to;
  const newBlockFrom = direction < 0 ? target.from : first.from + targetText.length + 1;
  const anchorOffset = selection.anchor - first.from;
  const headOffset = selection.head - first.from;

  view.dispatch({
    changes: { from, to, insert: replacement },
    selection: EditorSelection.single(newBlockFrom + anchorOffset, newBlockFrom + headOffset),
    scrollIntoView: true,
  });
  return true;
}

class MarkdownEditorAdapter {
  constructor(host, initialValue = "") {
    this.host = host;
    this.events = new EventTarget();
    this.lastSelection = "0:0";
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          EditorState.allowMultipleSelections.of(true),
          EditorView.clickAddsSelectionRange.of((event) => event.altKey),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          markdown(),
          syntaxHighlighting(markdownHighlightStyle, { fallback: true }),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search(),
          keymap.of(professionalKeymap),
          EditorView.lineWrapping,
          editorTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) this.events.dispatchEvent(new Event("input"));
            if (update.selectionSet) {
              const main = update.state.selection.main;
              const signature = `${main.from}:${main.to}`;
              if (signature !== this.lastSelection) {
                this.lastSelection = signature;
                this.events.dispatchEvent(new Event("select"));
              }
            }
          }),
          ViewPlugin.fromClass(class {
            constructor(view) {
              view.contentDOM.spellcheck = false;
              view.contentDOM.setAttribute("aria-label", "Markdown 专业编辑器");
            }
          }),
        ],
      }),
    });
  }

  get value() {
    return this.view.state.doc.toString();
  }

  set value(nextValue) {
    const value = String(nextValue ?? "");
    if (value === this.value) return;
    const previous = this.value;
    const selection = this.view.state.selection;
    const mapPosition = (position) => {
      const point = Math.max(0, Math.min(previous.length, Number(position) || 0));
      let prefix = 0;
      const limit = Math.min(previous.length, value.length);
      while (prefix < limit && previous[prefix] === value[prefix]) prefix += 1;
      let suffix = 0;
      while (
        suffix < previous.length - prefix &&
        suffix < value.length - prefix &&
        previous[previous.length - 1 - suffix] === value[value.length - 1 - suffix]
      ) suffix += 1;
      if (point <= prefix) return point;
      if (point >= previous.length - suffix) {
        return Math.max(prefix, Math.min(value.length, value.length - (previous.length - point)));
      }
      // When a formatter changes the current line, keep the cursor inside the
      // corresponding changed span instead of sending it to document start.
      const newSpan = Math.max(0, value.length - prefix - suffix);
      return Math.max(prefix, Math.min(value.length, prefix + Math.min(newSpan, point - prefix)));
    };
    const ranges = selection.ranges.map((range) =>
      EditorSelection.range(mapPosition(range.anchor), mapPosition(range.head)),
    );
    const nextSelection = EditorSelection.create(ranges, Math.min(selection.mainIndex, ranges.length - 1));
    const scrollTop = this.view.scrollDOM.scrollTop;
    const scrollLeft = this.view.scrollDOM.scrollLeft;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: value },
      selection: nextSelection,
      annotations: Transaction.addToHistory.of(false),
    });
    requestAnimationFrame(() => {
      this.view.scrollDOM.scrollTop = scrollTop;
      this.view.scrollDOM.scrollLeft = scrollLeft;
    });
  }

  get selectionStart() {
    return this.view.state.selection.main.from;
  }

  set selectionStart(value) {
    this.setSelectionRange(value, Math.max(Number(value) || 0, this.selectionEnd));
  }

  get selectionEnd() {
    return this.view.state.selection.main.to;
  }

  set selectionEnd(value) {
    this.setSelectionRange(Math.min(this.selectionStart, Number(value) || 0), value);
  }

  get scrollTop() {
    return this.view.scrollDOM.scrollTop;
  }

  set scrollTop(value) {
    this.view.scrollDOM.scrollTop = Number(value) || 0;
  }

  get scrollLeft() {
    return this.view.scrollDOM.scrollLeft;
  }

  set scrollLeft(value) {
    this.view.scrollDOM.scrollLeft = Number(value) || 0;
  }

  get scrollHeight() {
    return this.view.scrollDOM.scrollHeight;
  }

  get clientHeight() {
    return this.view.scrollDOM.clientHeight;
  }

  get classList() {
    return this.host.classList;
  }

  get style() {
    return this.host.style;
  }

  get isContentEditable() {
    return true;
  }

  get tagName() {
    return "DIV";
  }

  get hasFocus() {
    return this.view.hasFocus;
  }

  focus() {
    this.view.focus();
  }

  contains(node) {
    return this.host.contains(node);
  }

  getBoundingClientRect() {
    return this.view.contentDOM.getBoundingClientRect();
  }

  setSelectionRange(start, end = start) {
    const length = this.view.state.doc.length;
    const from = Math.max(0, Math.min(length, Number(start) || 0));
    const to = Math.max(from, Math.min(length, Number(end) || 0));
    this.view.dispatch({ selection: EditorSelection.single(from, to) });
  }

  setRangeText(replacement, start = this.selectionStart, end = this.selectionEnd, selectionMode = "preserve") {
    const insert = String(replacement ?? "");
    const length = this.view.state.doc.length;
    const from = Math.max(0, Math.min(length, Number(start) || 0));
    const to = Math.max(from, Math.min(length, Number(end) || 0));
    let anchor = from + insert.length;
    let head = anchor;
    if (selectionMode === "select") {
      anchor = from;
      head = from + insert.length;
    } else if (selectionMode === "start") {
      anchor = from;
      head = from;
    }
    this.view.dispatch({
      changes: { from, to, insert },
      selection: EditorSelection.single(anchor, head),
    });
  }

  undo() {
    undo({ state: this.view.state, dispatch: this.view.dispatch.bind(this.view) });
  }

  redo() {
    redo({ state: this.view.state, dispatch: this.view.dispatch.bind(this.view) });
  }

  scrollToLine(lineNumber) {
    const doc = this.view.state.doc;
    const target = Math.max(1, Math.min(doc.lines, Number(lineNumber) || 1));
    const line = doc.line(target);
    this.view.dispatch({
      selection: EditorSelection.single(line.from),
      scrollIntoView: { y: "center" },
    });
    this.view.focus();
    requestAnimationFrame(() => {
      const coords = this.view.coordsAtPos(line.from);
      if (!coords) return;
      const editorRect = this.view.scrollDOM.getBoundingClientRect();
      const lineCenter = coords.top + (coords.bottom - coords.top) / 2;
      const editorCenter = editorRect.top + this.view.scrollDOM.clientHeight / 2;
      const offset = lineCenter - editorCenter;
      if (Math.abs(offset) > 5) {
        this.view.scrollDOM.scrollTop += offset;
      }
    });
  }

  searchInEditor(query) {
    const term = String(query || "").trim();
    if (!term) return { total: 0, current: 0, matches: [] };
    const searchQuery = new SearchQuery({ search: term });
    const cursor = searchQuery.getCursor(this.view.state);
    const matches = [];
    while (true) {
      const result = cursor.next();
      if (result.done) break;
      matches.push({ from: result.value.from, to: result.value.to });
    }
    return { total: matches.length, matches };
  }

  replaceAll(searchText, replacementText) {
    const term = String(searchText || "").trim();
    if (!term) return 0;
    const replacement = String(replacementText ?? "");
    const searchQuery = new SearchQuery({ search: term });
    const cursor = searchQuery.getCursor(this.view.state);
    const changes = [];
    while (true) {
      const result = cursor.next();
      if (result.done) break;
      changes.push({ from: result.value.from, to: result.value.to, insert: replacement });
    }
    if (changes.length > 0) {
      this.view.dispatch({ changes });
    }
    this.view.focus();
    return changes.length;
  }

  jumpToMatch(from, to) {
    this.view.dispatch({
      selection: EditorSelection.single(from, to),
      scrollIntoView: true,
    });
    this.view.focus();
  }

  openSearchPanelWithQuery(query) {
    const term = String(query || "");
    this.view.focus();
    if (term) {
      const searchQuery = new SearchQuery({ search: term });
      this.view.dispatch({
        effects: setSearchQuery.of(searchQuery),
      });
    }
    openSearchPanel(this.view);
  }

  findNext() {
    findNext(this.view);
  }

  findPrevious() {
    findPrevious(this.view);
  }

  addEventListener(type, listener, options) {
    if (["input", "select"].includes(type)) {
      this.events.addEventListener(type, listener, options);
      return;
    }
    if (type === "scroll") {
      this.view.scrollDOM.addEventListener(type, listener, options);
      return;
    }
    this.view.contentDOM.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    if (["input", "select"].includes(type)) {
      this.events.removeEventListener(type, listener, options);
      return;
    }
    if (type === "scroll") {
      this.view.scrollDOM.removeEventListener(type, listener, options);
      return;
    }
    this.view.contentDOM.removeEventListener(type, listener, options);
  }

  dispatchEvent(event) {
    return this.events.dispatchEvent(event);
  }
}

export function createMarkdownEditor(host, initialValue = "") {
  if (!host) throw new Error("Markdown editor host is missing");
  return new MarkdownEditorAdapter(host, initialValue);
}
