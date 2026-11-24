import { isCancel, SelectPrompt } from "@clack/core";
import { limitOptions, S_BAR, S_BAR_END, symbol } from "@clack/prompts";
import pc from "picocolors";

/**
 * The published sessions as a list to act on. ↑/↓ moves, and Enter or a letter does its action to
 * the session the cursor is on. Resolves to `{ action, value }`, or null when Escape leaves the list.
 *
 * `options` are `{ value, name, lines, actions }`: the session's row and the address under it, and
 * the `{ key, label }` actions it takes, where the key is a letter or "enter". `closed` is what
 * stays on screen once the list is left.
 */
export async function pickPublished({ title, options, initialValue, closed, input, output }) {
  let action = null;
  const prompt = new SelectPrompt({
    options,
    initialValue: options.some((option) => option.value === initialValue) ? initialValue : options[0].value,
    input,
    output,
    // Enter on a session that takes no Enter leaves the list open and says why.
    validate: (value) => (options.find((option) => option.value === value)?.actions.some((item) => item.key === "enter") ? undefined : "Nothing to open: this session has no link."),
    render() {
      const bar = pc.gray(S_BAR);
      const current = options[this.cursor];
      if (this.state === "submit" && action) return `${bar}\n${symbol(this.state)}  ${title}\n${bar}  ${pc.dim(`${action.label}: ${current.name}`)}`;
      if (this.state === "cancel") return closed;

      const guide = `${pc.cyan(S_BAR)} `;
      const keys = current.actions.map((item) => `${pc.dim(`${item.key === "enter" ? "Enter" : item.key}:`)} ${item.label}`);
      const foot = [
        guide.trimEnd(),
        ...(this.state === "error" ? [`${guide} ${pc.yellow(this.error)}`] : []),
        `${guide} ${[`${pc.dim("↑/↓")} select`, ...keys, `${pc.dim("Esc:")} done`].join(" • ")}`,
        pc.cyan(S_BAR_END),
      ];
      const rows = limitOptions({
        cursor: this.cursor,
        options,
        columnPadding: 2,
        rowPadding: 3 + foot.length,
        output,
        // The row the cursor is on keeps its address bright; the others fade theirs.
        style: (option, active) => `${active ? pc.green("❯") : " "} ${option.lines[0]}\n      ${active ? option.lines[1] : pc.dim(option.lines[1])}`,
      });
      return [bar, `${symbol(this.state)}  ${title}`, guide.trimEnd(), ...rows.map((row) => `${pc.cyan(S_BAR)}${row}`), ...foot].join("\n");
    },
  });

  prompt.on("key", (character, key) => {
    const pressed = key?.name === "return" ? "enter" : character;
    const chosen = options[prompt.cursor].actions.find((item) => item.key === pressed);
    if (!chosen) return;
    action = chosen;
    // Enter ends the prompt by itself; a letter ends it the same way, with its action as the answer.
    if (pressed === "enter") return;
    prompt.state = "submit";
    prompt.emit("finalize");
    prompt.render();
    prompt.close();
  });

  const value = await prompt.prompt();
  return action && !isCancel(value) ? { action: action.key, value } : null;
}
