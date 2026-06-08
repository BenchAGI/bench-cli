// input-model.ts — pure line-editor reducer for the TUI input bar. No react/ink so the tricky bits
// (the approval-key race, history nav, multiline, cursor edits) are unit-testable in isolation.
// input.tsx wires ink's useInput into reduceInput and renders the resulting state.
import { matchHint, SLASH_COMMANDS } from "../repl/slash.js";
const HISTORY_CAP = 200;
export function initInput(history = []) {
    return { buffer: "", cursor: 0, history: history.slice(-HISTORY_CAP), histIndex: null, draft: "" };
}
function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}
function setBuffer(state, buffer, cursor = buffer.length) {
    return { ...state, buffer, cursor: clamp(cursor, 0, buffer.length), histIndex: null };
}
function pushHistory(history, line) {
    if (history[history.length - 1] === line)
        return history;
    return [...history, line].slice(-HISTORY_CAP);
}
// Reduce one key event. Returns the next state plus any action the app should take.
export function reduceInput(state, input, key, ctx = {}) {
    const none = (s) => ({ state: s, action: { type: "none" } });
    // 1) Approval-key gate — re-solves the readline fast-key race. A/D/r act on a pending approval
    //    ONLY when the buffer is empty; once you've started typing a message they're literal text.
    if (ctx.approvalActive && state.buffer.length === 0 && !key.ctrl && !key.meta && /^[adr]$/i.test(input)) {
        return { state, action: { type: "approval", key: input.toLowerCase() } };
    }
    // 2) Enter — submit, or continue a multiline line (trailing backslash → newline).
    if (key.return) {
        if (state.buffer.endsWith("\\")) {
            const next = state.buffer.slice(0, -1) + "\n";
            return none(setBuffer(state, next));
        }
        const line = state.buffer;
        if (line.trim().length === 0)
            return none({ ...state, buffer: "", cursor: 0, histIndex: null });
        const history = pushHistory(state.history, line);
        return {
            state: { buffer: "", cursor: 0, history, histIndex: null, draft: "" },
            action: { type: "submit", line },
        };
    }
    // 3) Control chords.
    if (key.ctrl && input === "u")
        return none({ ...state, buffer: "", cursor: 0, histIndex: null });
    if (key.ctrl && input === "a")
        return none({ ...state, cursor: 0 });
    if (key.ctrl && input === "e")
        return none({ ...state, cursor: state.buffer.length });
    if (key.ctrl && input === "k")
        return none({ ...state, buffer: state.buffer.slice(0, state.cursor) });
    // 4) Backspace / delete-before-cursor (mac sends backspace for the Delete key).
    if (key.backspace || key.delete) {
        if (state.cursor === 0)
            return none(state);
        const next = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor);
        return none({ ...state, buffer: next, cursor: state.cursor - 1, histIndex: null });
    }
    // 5) Cursor movement.
    if (key.leftArrow)
        return none({ ...state, cursor: clamp(state.cursor - 1, 0, state.buffer.length) });
    if (key.rightArrow)
        return none({ ...state, cursor: clamp(state.cursor + 1, 0, state.buffer.length) });
    // 6) History (↑/↓). Saves the live draft on first entry, restores it past the newest entry.
    if (key.upArrow) {
        if (state.history.length === 0)
            return none(state);
        const idx = state.histIndex === null ? state.history.length - 1 : Math.max(0, state.histIndex - 1);
        const draft = state.histIndex === null ? state.buffer : state.draft;
        const buffer = state.history[idx];
        return none({ ...state, histIndex: idx, draft, buffer, cursor: buffer.length });
    }
    if (key.downArrow) {
        if (state.histIndex === null)
            return none(state);
        const idx = state.histIndex + 1;
        if (idx >= state.history.length) {
            const buffer = state.draft;
            return none({ ...state, histIndex: null, buffer, cursor: buffer.length, draft: "" });
        }
        const buffer = state.history[idx];
        return none({ ...state, histIndex: idx, buffer, cursor: buffer.length });
    }
    // 7) Tab — slash autocomplete when there's exactly one candidate.
    if (key.tab) {
        const hits = matchHint(state.buffer, ctx.registry ?? SLASH_COMMANDS);
        if (hits.length === 1) {
            const completed = `/${hits[0].name} `;
            return none(setBuffer(state, completed));
        }
        return none(state);
    }
    // 8) Printable insertion (ignore control/meta chords and empty input).
    if (input && !key.ctrl && !key.meta && !key.escape) {
        const next = state.buffer.slice(0, state.cursor) + input + state.buffer.slice(state.cursor);
        return none({ ...state, buffer: next, cursor: state.cursor + input.length, histIndex: null });
    }
    return none(state);
}
